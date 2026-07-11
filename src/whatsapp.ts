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
import { AUTH_DIR, DOWNLOADS_DIR, CONFIG_DIR } from "./paths.js";
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

let sock: WASocket | undefined;
let connectionState: "connecting" | "open" | "closed" = "connecting";
let linkedNumber: string | undefined;
let lastConnectedAt: number | undefined;

// Elke socket krijgt een eigen epoch. Alleen de socket die nog de actuele is mag
// een reconnect starten; events van een afgedankte socket worden genegeerd.
let socketEpoch = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

export function getStatus() {
  return { connectionState, linkedNumber, lastConnectedAt };
}

export function getSocket(): WASocket {
  if (!sock) throw new Error("WhatsApp socket not initialized yet");
  return sock;
}

// Wacht tot de verbinding open is. Zonder deze gate stuurt een send naar een
// socket die net wegvalt, en blijft die call hangen tot de media-upload opgeeft.
export async function waitUntilConnected(timeoutMs = CONNECT_WAIT_MS): Promise<WASocket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sock && connectionState === "open") return sock;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`WhatsApp-verbinding is niet open (status: ${connectionState}) na ${Math.round(timeoutMs / 1000)}s wachten.`);
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

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  log(`Herverbinden over ${Math.round(delay / 1000)}s (poging ${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWhatsApp().catch((err) => {
      log(`Reconnect mislukt: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
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

async function handleIncomingMessage(msg: proto.IWebMessageInfo) {
  if (!msg.key) return;
  const chatJid = msg.key.remoteJid;
  if (!chatJid || chatJid === "status@broadcast") return;

  const id = msg.key.id ?? "";
  const fromMe = msg.key.fromMe ?? false;
  const sender = fromMe ? undefined : (msg.key.participant ?? chatJid);
  const timestamp = Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000;

  const row: MessageRow = {
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
    upsertMediaMessage(chatJid, id, Buffer.from(proto.WebMessageInfo.encode(msg).finish()));
  }

  const name = msg.pushName ?? undefined;
  if (name && !fromMe) {
    upsertContact(chatJid, name, chatJid.endsWith("@s.whatsapp.net") ? chatJid.split("@")[0] : null);
  }
}

export function getStoredMediaMessage(chatJid: string, id: string): proto.IWebMessageInfo | undefined {
  const raw = getMediaMessageRaw(chatJid, id);
  if (!raw) return undefined;
  return proto.WebMessageInfo.decode(raw);
}

export async function downloadMessageMedia(msg: proto.IWebMessageInfo): Promise<string> {
  if (!msg.key) throw new Error("Bericht heeft geen key, kan media niet downloaden");
  const buffer = (await downloadMediaMessage(msg as Parameters<typeof downloadMediaMessage>[0], "buffer", {})) as Buffer;
  const ext = messageType(msg);
  const filename = `${msg.key.id}.${ext === "image" ? "jpg" : ext === "video" ? "mp4" : ext === "audio" ? "ogg" : "bin"}`;
  const filePath = join(DOWNLOADS_DIR, filename);
  await writeFile(filePath, buffer);
  return filePath;
}

export async function connectWhatsApp(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  await teardownSocket(sock);
  sock = undefined;

  const epoch = ++socketEpoch;
  connectionState = "connecting";

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const current = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["whatsapp-mcp-server", "Chrome", "1.0.0"],
    // Anders staat het account permanent "online" zolang de server draait,
    // en onderdrukt WhatsApp pushmeldingen naar de telefoon.
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });
  sock = current;

  current.ev.on("creds.update", saveCreds);

  current.ev.on("connection.update", (update) => {
    if (epoch !== socketEpoch) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan deze QR-code met WhatsApp (Gekoppelde apparaten > Apparaat koppelen):\n");
      qrcode.generate(qr, { small: true });
      writeFile(join(CONFIG_DIR, "qr.txt"), qr).catch(() => {});
    }

    if (connection === "open") {
      rm(join(CONFIG_DIR, "qr.txt"), { force: true }).catch(() => {});
      connectionState = "open";
      lastConnectedAt = Date.now();
      reconnectAttempts = 0;
      linkedNumber = current.user?.id?.split(":")[0];
      log(`WhatsApp verbonden als ${linkedNumber}`);
    } else if (connection === "close") {
      connectionState = "closed";
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log(`WhatsApp-verbinding gesloten (code ${statusCode}). Herverbinden: ${shouldReconnect}`);
      if (shouldReconnect) {
        scheduleReconnect();
      } else {
        log("Sessie uitgelogd. Verwijder de auth-map en scan opnieuw een QR-code.");
      }
    } else if (connection === "connecting") {
      connectionState = "connecting";
    }
  });

  current.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      handleIncomingMessage(msg).catch((err) => console.error("Fout bij verwerken bericht:", err));
    }
  });

  current.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    for (const chat of chats) {
      if (!chat.id) continue;
      upsertChat(chat.id, chat.name ?? null, chat.id.endsWith("@g.us"), chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : null);
    }
    for (const contact of contacts) {
      if (contact.id) upsertContact(contact.id, contact.name ?? contact.notify ?? null, contact.id.split("@")[0] ?? null);
    }
    for (const msg of messages) {
      handleIncomingMessage(msg).catch((err) => console.error("Fout bij verwerken geschiedenis:", err));
    }
  });

  current.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id) upsertContact(contact.id, contact.name ?? contact.notify ?? null, contact.id.split("@")[0] ?? null);
    }
  });
}
