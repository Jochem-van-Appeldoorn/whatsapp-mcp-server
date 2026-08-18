import { sync as spawnSync } from "cross-spawn";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { waitUntilConnected, getStoredMediaMessage, downloadMessageMedia } from "./whatsapp.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);
const AUDIO_EXT = new Set([".mp3", ".ogg", ".m4a", ".wav", ".aac", ".opus"]);

const SEND_TIMEOUT_MS = 120_000;

// Baileys geeft een media-upload geen eigen deadline: valt de socket weg tijdens
// het versturen, dan blijft de call hangen. Liever een duidelijke fout.
async function withSendTimeout<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Versturen van ${what} duurde langer dan ${SEND_TIMEOUT_MS / 1000}s en is afgebroken.`)),
      SEND_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadSource(source: string): Promise<{ buffer: Buffer; filename: string }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Kon ${source} niet downloaden (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = basename(new URL(source).pathname) || "bestand";
    return { buffer, filename };
  }
  const buffer = await readFile(source);
  return { buffer, filename: basename(source) };
}

export function isFfmpegAvailable(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

async function convertToOggOpus(inputPath: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "wa-voice-"));
  const outputPath = join(dir, "voice.ogg");
  try {
    const result = spawnSync("ffmpeg", ["-y", "-i", inputPath, "-c:a", "libopus", "-ar", "48000", "-ac", "1", outputPath], {
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error("ffmpeg-conversie naar ogg/opus is mislukt");
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sendFile(jid: string, source: string, caption?: string): Promise<void> {
  const { buffer, filename } = await loadSource(source);
  const ext = extname(filename).toLowerCase();
  const sock = await waitUntilConnected();

  if (IMAGE_EXT.has(ext)) {
    await withSendTimeout(filename, sock.sendMessage(jid, { image: buffer, caption }));
  } else if (VIDEO_EXT.has(ext)) {
    await withSendTimeout(filename, sock.sendMessage(jid, { video: buffer, caption }));
  } else {
    await withSendTimeout(
      filename,
      sock.sendMessage(jid, { document: buffer, fileName: filename, caption, mimetype: "application/octet-stream" })
    );
  }
}

export async function sendVoiceMessage(jid: string, source: string): Promise<{ sentAsVoiceNote: boolean; note?: string }> {
  const isLocal = !/^https?:\/\//i.test(source);
  const ext = extname(source).toLowerCase();
  const sock = await waitUntilConnected();

  if (ext === ".ogg" || ext === ".opus") {
    const { buffer } = await loadSource(source);
    await withSendTimeout(basename(source), sock.sendMessage(jid, { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true }));
    return { sentAsVoiceNote: true };
  }

  if (!isFfmpegAvailable()) {
    await sendFile(jid, source);
    return {
      sentAsVoiceNote: false,
      note: "ffmpeg is niet geïnstalleerd, dus het bestand is als gewoon audiobestand verstuurd (geen afspeelbaar voice-bericht). Installeer ffmpeg voor echte voice notes.",
    };
  }

  if (!isLocal) {
    const { buffer, filename } = await loadSource(source);
    const dir = await mkdtemp(join(tmpdir(), "wa-voice-src-"));
    const tmpFile = join(dir, filename);
    await writeFile(tmpFile, buffer);
    try {
      const converted = await convertToOggOpus(tmpFile);
      await withSendTimeout(filename, sock.sendMessage(jid, { audio: converted, mimetype: "audio/ogg; codecs=opus", ptt: true }));
      return { sentAsVoiceNote: true };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const converted = await convertToOggOpus(source);
  await withSendTimeout(basename(source), sock.sendMessage(jid, { audio: converted, mimetype: "audio/ogg; codecs=opus", ptt: true }));
  return { sentAsVoiceNote: true };
}

export async function downloadIncomingMedia(chatJid: string, messageId: string): Promise<string> {
  const msg = getStoredMediaMessage(chatJid, messageId);
  if (!msg) {
    throw new Error(
      "Geen media gevonden voor dit bericht. Media kan alleen gedownload worden als de server verbonden was toen het bericht binnenkwam."
    );
  }
  return downloadMessageMedia(msg);
}
