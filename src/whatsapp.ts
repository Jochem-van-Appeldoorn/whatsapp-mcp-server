import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { authDir, qrPath, downloadsDir } from "./paths.js";
import { ACCOUNTS, getAccount, type AccountConfig } from "./accounts.js";
import { insertMessage, upsertContact, upsertChat, upsertMediaMessage, getMediaMessageRaw, type MessageRow } from "./db.js";

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const CONNECT_WAIT_MS = 45_000;

const HANDLED_EVENTS = [
  "creds.update",
  "connection.update",
  "messages.upsert",
  "messaging-history.set",
  "contacts.upsert",
] as const;

const logger = pino({ level: "silent" });

// Elk account is een eigen gekoppeld apparaat met een eigen socket, eigen
// auth-map en een eigen reconnect-ritme. Wat hier vroeger module-variabelen
// waren staat nu per account in deze map.
interface AccountRuntime {
  config: AccountConfig;
  sock?: WASocket;
  connectionState: "connecting" | "open" | "closed";
  linkedNumber?: string;
  lastConnectedAt?: number;
  // Elke socket krijgt een eigen epoch. Alleen de socket die nog de actuele is
  // mag een reconnect starten; events van een afgedankte socket worden genegeerd.
  socketEpoch: number;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

const runtimes = new Map<string, AccountRuntime>();

for (const config of ACCOUNTS) {
  runtimes.set(config.id, { config, connectionState: "connecting", socketEpoch: 0, reconnectAttempts: 0 });
}

function runtime(accountId: string): AccountRuntime {
  const rt = runtimes.get(accountId);
  if (!rt) throw new Error(`Onbekend account '${accountId}'.`);
  return rt;
}

function log(accountId: string, message: string) {
  console.log(`${new Date().toISOString()} [${accountId}] ${message}`);
}

export interface AccountStatus {
  account: string;
  label: string;
  connectionState: "connecting" | "open" | "closed";
  linkedNumber?: string;
  expectedNumber?: string;
  lastConnectedAt?: number;
  canSend: boolean;
}

export function getStatus(accountId: string): AccountStatus {
  const rt = runtime(accountId);
  return {
    account: rt.config.id,
    label: rt.config.label,
    connectionState: rt.connectionState,
    linkedNumber: rt.linkedNumber,
    expectedNumber: rt.config.number,
    lastConnectedAt: rt.lastConnectedAt,
    canSend: rt.config.canSend,
  };
}

export function getStatuses(): AccountStatus[] {
  return ACCOUNTS.map((a) => getStatus(a.id));
}

export function getSocket(accountId: string): WASocket {
  const rt = runtime(accountId);
  if (!rt.sock) throw new Error(`WhatsApp-socket van '${accountId}' is nog niet opgestart.`);
  return rt.sock;
}

// Wacht tot de verbinding open is. Zonder deze gate stuurt een send naar een
// socket die net wegvalt, en blijft die call hangen tot de media-upload opgeeft.
export async function waitUntilConnected(accountId: string, timeoutMs = CONNECT_WAIT_MS): Promise<WASocket> {
  const rt = runtime(accountId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rt.sock && rt.connectionState === "open") return rt.sock;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `WhatsApp-verbinding van '${accountId}' is niet open (status: ${rt.connectionState}) na ${Math.round(
      timeoutMs / 1000
    )}s wachten.`
  );
}

// Zonder expliciete teardown blijft een afgedankte socket zijn keep-alive-timer
// draaien, time-outen met code 408, en via zijn nog aangehechte listener een
// nieuwe socket starten. Dat vermenigvuldigt zich per ronde.
async function teardownSocket(target: WASocket | undefined) {
  if (!target) return;
  for (const event of HANDLED_EVENTS) {
    try {
      target.ev.removeAllListeners(event);
    } catch {
      // listener was er al niet meer
    }
  }
  try {
    await target.end(undefined);
  } catch {
    // socket lag al plat
  }
}

function scheduleReconnect(accountId: string) {
  const rt = runtime(accountId);
  if (rt.reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** rt.reconnectAttempts, RECONNECT_MAX_MS);
  rt.reconnectAttempts += 1;
  log(accountId, `Herverbinden over ${Math.round(delay / 1000)}s (poging ${rt.reconnectAttempts}).`);
  rt.reconnectTimer = setTimeout(() => {
    rt.reconnectTimer = undefined;
    connectAccount(accountId).catch((err) => {
      log(accountId, `Reconnect mislukt: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect(accountId);
    });
  }, delay);
}

function extractText(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

function messageType(msg: proto.IWebMessageInfo): string {
  const m = msg.message;
  if (!m) return "unknown";
  if (m.conversation || m.extendedTextMessage) return "text";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  return "other";
}

async function handleIncomingMessage(accountId: string, msg: proto.IWebMessageInfo) {
  if (!msg.key) return;
  const chatJid = msg.key.remoteJid;
  if (!chatJid || chatJid === "status@broadcast") return;

  const id = msg.key.id ?? "";
  const fromMe = msg.key.fromMe ?? false;
  const sender = fromMe ? undefined : (msg.key.participant ?? chatJid);
  const timestamp = Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000;

  const row: MessageRow = {
    account: accountId,
    chat_jid: chatJid,
    id,
    from_me: fromMe ? 1 : 0,
    sender: sender ?? null,
    text: extractText(msg),
    type: messageType(msg),
    media_path: null,
    timestamp,
  };
  insertMessage(row);

  if (MEDIA_TYPES.has(row.type)) {
    upsertMediaMessage(accountId, chatJid, id, Buffer.from(proto.WebMessageInfo.encode(msg).finish()));
  }

  const name = msg.pushName ?? undefined;
  if (name && !fromMe) {
    upsertContact(accountId, chatJid, name, chatJid.endsWith("@s.whatsapp.net") ? chatJid.split("@")[0] : null);
  }
}

export function getStoredMediaMessage(
  chatJid: string,
  id: string,
  account?: string
): { msg: proto.IWebMessageInfo; account: string } | undefined {
  const row = getMediaMessageRaw(chatJid, id, account);
  if (!row) return undefined;
  return { msg: proto.WebMessageInfo.decode(row.raw), account: row.account };
}

export async function downloadMessageMedia(accountId: string, msg: proto.IWebMessageInfo): Promise<string> {
  if (!msg.key) throw new Error("Bericht heeft geen key, kan media niet downloaden");
  const buffer = (await downloadMediaMessage(msg as Parameters<typeof downloadMediaMessage>[0], "buffer", {})) as Buffer;
  const ext = messageType(msg);
  const filename = `${msg.key.id}.${ext === "image" ? "jpg" : ext === "video" ? "mp4" : ext === "audio" ? "ogg" : "bin"}`;
  const filePath = join(downloadsDir(accountId), filename);
  await writeFile(filePath, buffer);
  return filePath;
}

export async function connectAccount(accountId: string): Promise<void> {
  const rt = runtime(accountId);
  const config = getAccount(accountId);

  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = undefined;
  }
  await teardownSocket(rt.sock);
  rt.sock = undefined;

  const epoch = ++rt.socketEpoch;
  rt.connectionState = "connecting";

  const { state, saveCreds } = await useMultiFileAuthState(authDir(accountId));
  const { version } = await fetchLatestBaileysVersion();

  const current = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    // WhatsApp weigerde het koppelen (401) zolang hier een niet-bestaand
    // platform stond ("whatsapp-mcp-server"). Houd dit een herkenbare
    // desktop-identificatie.
    browser: ["Mac OS", "Chrome", "121.0.0"],
    // Anders staat het account permanent "online" zolang de server draait,
    // en onderdrukt WhatsApp pushmeldingen naar de telefoon.
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });
  rt.sock = current;

  current.ev.on("creds.update", saveCreds);

  current.ev.on("connection.update", (update) => {
    if (epoch !== rt.socketEpoch) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        `\nScan deze QR-code met WhatsApp op ${config.label}${
          config.number ? ` (${config.number})` : ""
        } — Gekoppelde apparaten > Apparaat koppelen:\n`
      );
      qrcode.generate(qr, { small: true });
      writeFile(qrPath(accountId), qr).catch(() => {});
    }

    if (connection === "open") {
      rm(qrPath(accountId), { force: true }).catch(() => {});
      rt.connectionState = "open";
      rt.lastConnectedAt = Date.now();
      rt.reconnectAttempts = 0;
      rt.linkedNumber = current.user?.id?.split(":")[0];
      log(accountId, `WhatsApp verbonden als ${rt.linkedNumber}`);
      if (config.number && rt.linkedNumber && rt.linkedNumber !== config.number) {
        log(
          accountId,
          `LET OP: verwacht nummer ${config.number}, maar gekoppeld is ${rt.linkedNumber}. ` +
            `Controleer welk toestel hier gescand is voordat je dit account gebruikt.`
        );
      }
    } else if (connection === "close") {
      rt.connectionState = "closed";
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log(accountId, `WhatsApp-verbinding gesloten (code ${statusCode}). Herverbinden: ${shouldReconnect}`);
      if (shouldReconnect) {
        scheduleReconnect(accountId);
      } else {
        log(accountId, `Sessie uitgelogd. Verwijder ${authDir(accountId)} en scan opnieuw een QR-code.`);
      }
    } else if (connection === "connecting") {
      rt.connectionState = "connecting";
    }
  });

  current.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      handleIncomingMessage(accountId, msg).catch((err) => console.error(`[${accountId}] Fout bij verwerken bericht:`, err));
    }
  });

  current.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    for (const chat of chats) {
      if (!chat.id) continue;
      upsertChat(
        accountId,
        chat.id,
        chat.name ?? null,
        chat.id.endsWith("@g.us"),
        chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : null
      );
    }
    for (const contact of contacts) {
      if (contact.id) upsertContact(accountId, contact.id, contact.name ?? contact.notify ?? null, contact.id.split("@")[0] ?? null);
    }
    for (const msg of messages) {
      handleIncomingMessage(accountId, msg).catch((err) =>
        console.error(`[${accountId}] Fout bij verwerken geschiedenis:`, err)
      );
    }
  });

  current.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id) upsertContact(accountId, contact.id, contact.name ?? contact.notify ?? null, contact.id.split("@")[0] ?? null);
    }
  });
}

/**
 * Start alle accounts op. Eén account dat niet wil koppelen mag de rest niet
 * tegenhouden: de server draait door en probeert dat account opnieuw.
 */
export async function connectAll(): Promise<void> {
  await Promise.all(
    ACCOUNTS.map((account) =>
      connectAccount(account.id).catch((err) => {
        log(account.id, `Verbinden mislukt: ${err instanceof Error ? err.message : String(err)}`);
        scheduleReconnect(account.id);
      })
    )
  );
}
