import { db } from "./db.js";

/**
 * Rem op uitgaand verkeer.
 *
 * WhatsApp sluit nummers af die zich als automaat gedragen. Davids eigen
 * gebruik zit ruim onder elke grens (hooguit 29 berichten op een dag, piek 9
 * in een minuut), dus deze limieten raken normaal werk niet. Ze zijn er voor
 * het geval dat er iets op hol slaat: een agent in een retry-lus die honderd
 * keer dezelfde storingsmelding stuurt, is precies hoe je een nummer kwijtraakt.
 */

const MIN_GAP_MS = Number(process.env.WHATSAPP_MCP_MIN_GAP_MS ?? 3_000);
const MAX_PER_HOUR = Number(process.env.WHATSAPP_MCP_MAX_PER_HOUR ?? 40);
const MAX_PER_DAY = Number(process.env.WHATSAPP_MCP_MAX_PER_DAY ?? 150);
// Dezelfde tekst naar meer dan dit aantal chats binnen een uur is een rondzending.
const MAX_SAME_TEXT_CHATS = Number(process.env.WHATSAPP_MCP_MAX_SAME_TEXT_CHATS ?? 4);

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

interface SendRecord {
  account: string;
  jid: string;
  text: string;
  at: number;
}

const sends: SendRecord[] = [];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Vult de teller met wat er de afgelopen dag al verstuurd is, zodat een
 * herstart van de server geen schone lei geeft.
 */
function seedFromDatabase() {
  try {
    const rows = db
      .prepare(
        `SELECT account, chat_jid, text, timestamp FROM messages
         WHERE from_me = 1 AND timestamp > ? ORDER BY timestamp`
      )
      .all(Date.now() - DAY_MS) as { account: string; chat_jid: string; text: string | null; timestamp: number }[];
    for (const r of rows) {
      sends.push({ account: r.account, jid: r.chat_jid, text: normalize(r.text ?? ""), at: r.timestamp });
    }
  } catch {
    // Geen geschiedenis is geen reden om niet te starten.
  }
}

seedFromDatabase();

function prune(now: number) {
  const cutoff = now - DAY_MS;
  while (sends.length && sends[0].at < cutoff) sends.shift();
}

export type ThrottleResult = { ok: true; waitMs: number } | { ok: false; reason: string };

/**
 * Toetst een voorgenomen verzending. `waitMs` is de tijd die de aanroeper nog
 * moet wachten om niet te snel achter elkaar te sturen; dat is geen fout.
 */
export function checkSendRate(account: string, jid: string, subject: string): ThrottleResult {
  const now = Date.now();
  prune(now);

  const mine = sends.filter((s) => s.account === account);
  const lastHour = mine.filter((s) => s.at > now - HOUR_MS);
  const lastDay = mine;

  if (lastDay.length >= MAX_PER_DAY) {
    return {
      ok: false,
      reason:
        `Dagelijkse verzendlimiet bereikt voor '${account}' (${MAX_PER_DAY} berichten in 24 uur). ` +
        `Dit is een rem tegen een vastgelopen lus. Klopt het dat er zoveel weg moet, overleg dan met David ` +
        `voordat je de limiet verhoogt via WHATSAPP_MCP_MAX_PER_DAY.`,
    };
  }
  if (lastHour.length >= MAX_PER_HOUR) {
    return {
      ok: false,
      reason:
        `Uurlimiet bereikt voor '${account}' (${MAX_PER_HOUR} berichten in het afgelopen uur). ` +
        `Wacht tot het rustiger is of overleg met David.`,
    };
  }

  const normalized = normalize(subject);
  if (normalized) {
    const sameText = new Set(
      sends.filter((s) => s.at > now - HOUR_MS && s.text === normalized).map((s) => s.jid)
    );
    if (!sameText.has(jid) && sameText.size >= MAX_SAME_TEXT_CHATS) {
      return {
        ok: false,
        reason:
          `Deze tekst is het afgelopen uur al naar ${sameText.size} chats gestuurd. Een rondzending van hetzelfde ` +
          `bericht is precies waar WhatsApp nummers voor afsluit. Stuur het gericht, of leg het aan David voor.`,
      };
    }
  }

  const last = mine.length ? mine[mine.length - 1].at : 0;
  const gap = now - last;
  return { ok: true, waitMs: gap >= MIN_GAP_MS ? 0 : MIN_GAP_MS - gap };
}

export function recordSend(account: string, jid: string, subject: string) {
  sends.push({ account, jid, text: normalize(subject), at: Date.now() });
}

export async function waitOut(ms: number) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

export function rateSummary(account: string): string {
  const now = Date.now();
  prune(now);
  const mine = sends.filter((s) => s.account === account);
  const hour = mine.filter((s) => s.at > now - HOUR_MS).length;
  return `${hour}/${MAX_PER_HOUR} dit uur, ${mine.length}/${MAX_PER_DAY} vandaag`;
}
