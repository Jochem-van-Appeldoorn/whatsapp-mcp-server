import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
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
import {
  insertMessage,
  upsertContact,
  upsertChat,
  upsertMediaMessage,
  getMediaMessageRaw,
  mergeChatJid,
  getAllLidChatJids,
  type MessageRow,
} from "./db.js";

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

/**
 * WhatsApp adresseert dezelfde contactpersoon soms via een telefoonnummer-JID
 * (@s.whatsapp.net) en soms via een interne @lid-identiteit (bv. gekoppelde/business
 * apparaten). Zonder normalisatie versplintert één gesprek zo over twee "chats" in
 * onze database. Herleid @lid altijd naar de telefoonnummer-JID wanneer die mapping
 * bekend is, zodat alles in één chat_jid terechtkomt.
 */
async function resolveCanonicalJid(jid: string): Promise<string> {
  if (!jid.endsWith("@lid") || !sock) return jid;
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
    if (pn) return jidNormalizedUser(pn);
  } catch (err) {
    console.error(`Kon LID ${jid} niet herleiden naar telefoonnummer:`, err);
  }
  return jid;
}

/**
 * Voegt alle reeds opgeslagen @lid-chats samen met hun canonieke telefoonnummer-JID,
 * voor gesprekken die vóór deze fix al gesplitst waren opgeslagen.
 */
async function reconcileLidChats(): Promise<void> {
  for (const lidJid of getAllLidChatJids()) {
    const canonical = await resolveCanonicalJid(lidJid);
    if (canonical !== lidJid) {
      console.log(`Voeg gesplitste chat samen: ${lidJid} -> ${canonical}`);
      mergeChatJid(lidJid, canonical);
    }
  }
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
  const rawChatJid = msg.key.remoteJid;
  if (!rawChatJid || rawChatJid === "status@broadcast") return;

  const chatJid = await resolveCanonicalJid(rawChatJid);
  const id = msg.key.id ?? "";
  const fromMe = msg.key.fromMe ?? false;
  const rawSender = fromMe ? undefined : (msg.key.participant ?? rawChatJid);
  const sender = rawSender ? await resolveCanonicalJid(rawSender) : undefined;
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

  // pushName is de weergavenaam van de AFZENDER, niet van het gesprek. In een 1-op-1 chat zijn die
  // twee hetzelfde, dus daar viel het niet op. In een groep is chatJid de groep, en die kreeg zo de
  // naam van wie er als laatste sprak — waarna getDisplayName die naam toonde in plaats van het
  // onderwerp, en een groep dus niet op naam terug te vinden was.
  const name = msg.pushName ?? undefined;
  if (name && !fromMe && sender) {
    upsertContact(sender, name, sender.endsWith("@s.whatsapp.net") ? sender.split("@")[0] : null);
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
    // Standaard leeft een QR maar 20-60s; te kort om een afbeelding naar de
    // gebruiker te sturen en te laten scannen. Ruim verlengen bij het
    // eenmalig koppelen van een nieuw apparaat.
    qrTimeout: 120_000,
    browser: ["whatsapp-mcp-server", "Chrome", "1.0.0"],
    // Anders staat het account permanent "online" zolang de server draait,
    // en onderdrukt WhatsApp pushmeldingen naar de telefoon.
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
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
      linkedNumber = sock?.user?.id?.split(":")[0];
      console.log(`WhatsApp verbonden als ${linkedNumber}`);
      reconcileLidChats().catch((err) => console.error("Reconciliatie van @lid-chats mislukt:", err));
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
      resolveCanonicalJid(chat.id)
        .then((jid) => upsertChat(jid, chat.name ?? null, jid.endsWith("@g.us"), chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : null))
        .catch((err) => console.error("Fout bij verwerken chat-geschiedenis:", err));
    }
    for (const contact of contacts) {
      if (!contact.id) continue;
      resolveCanonicalJid(contact.id)
        .then((jid) => upsertContact(jid, contact.name ?? contact.notify ?? null, jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null))
        .catch((err) => console.error("Fout bij verwerken contact-geschiedenis:", err));
    }
    for (const msg of messages) {
      handleIncomingMessage(msg).catch((err) => console.error("Fout bij verwerken geschiedenis:", err));
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue;
      resolveCanonicalJid(contact.id)
        .then((jid) => upsertContact(jid, contact.name ?? contact.notify ?? null, jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null))
        .catch((err) => console.error("Fout bij verwerken contact-update:", err));
    }
  });
}
