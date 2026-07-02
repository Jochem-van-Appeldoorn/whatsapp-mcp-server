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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_DIR, DOWNLOADS_DIR } from "./paths.js";
import { insertMessage, upsertContact, upsertChat, upsertMediaMessage, getMediaMessageRaw, type MessageRow } from "./db.js";

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

const logger = pino({ level: "silent" });

let sock: WASocket | undefined;
let connectionState: "connecting" | "open" | "closed" = "connecting";
let linkedNumber: string | undefined;
let lastConnectedAt: number | undefined;

export function getStatus() {
  return { connectionState, linkedNumber, lastConnectedAt };
}

export function getSocket(): WASocket {
  if (!sock) throw new Error("WhatsApp socket not initialized yet");
  return sock;
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["whatsapp-mcp-server", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan deze QR-code met WhatsApp (Gekoppelde apparaten > Apparaat koppelen):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      connectionState = "open";
      lastConnectedAt = Date.now();
      linkedNumber = sock?.user?.id?.split(":")[0];
      console.log(`WhatsApp verbonden als ${linkedNumber}`);
    } else if (connection === "close") {
      connectionState = "closed";
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`WhatsApp-verbinding gesloten (code ${statusCode}). Herverbinden: ${shouldReconnect}`);
      if (shouldReconnect) {
        connectWhatsApp().catch((err) => console.error("Reconnect mislukt:", err));
      } else {
        console.error("Sessie uitgelogd. Verwijder de auth-map en scan opnieuw een QR-code.");
      }
    } else if (connection === "connecting") {
      connectionState = "connecting";
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      handleIncomingMessage(msg).catch((err) => console.error("Fout bij verwerken bericht:", err));
    }
  });

  sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
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

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id) upsertContact(contact.id, contact.name ?? contact.notify ?? null, contact.id.split("@")[0] ?? null);
    }
  });
}
