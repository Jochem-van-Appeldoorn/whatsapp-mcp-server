import { z } from "zod";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveChatTarget, type ResolveResult } from "./contacts.js";
import * as db from "./db.js";
import * as media from "./media.js";
import { getSocket, getStatus } from "./whatsapp.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TZ = "Europe/Amsterdam";
const MAX_BODY_CHARS = 400;
const MAX_AMBIGUOUS_CANDIDATES = 8;

// sv-SE levert ISO-achtige datums ("2026-07-02") en 24-uurs tijden, altijd in
// TZ — onafhankelijk van de systeem-tijdzone waar de server draait.
const dateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clockFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const weekdayShortFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, weekday: "short" });
const weekdayLongFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, weekday: "long" });

function fmtDate(epochMs: number): string {
  return dateFmt.format(new Date(epochMs));
}

function fmtClock(epochMs: number): string {
  return clockFmt.format(new Date(epochMs));
}

function fmtTime(epochMs: number): string {
  return `${fmtDate(epochMs)} ${fmtClock(epochMs)}`;
}

function dayHeader(epochMs: number): string {
  return `— ${weekdayShortFmt.format(new Date(epochMs))} ${fmtDate(epochMs)} —`;
}

function nowLine(): string {
  const now = Date.now();
  return `Nu: ${weekdayShortFmt.format(now)} ${fmtTime(now)}`;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Toon telefoonnummer-JIDs als kaal nummer; @g.us/@lid (en shortcodes)
// blijven intact omdat die niet als nummer terug te resolven zijn.
function displayJid(jid: string): string {
  const [user, server] = jid.split("@");
  if (server === "s.whatsapp.net" && /^\d{8,}$/.test(user)) return user;
  return jid;
}

function targetLabel(name: string | null, jid: string): string {
  const id = displayJid(jid);
  return name && name !== id ? `${name} (${id})` : id;
}

function requireResolved(
  result: ResolveResult
): { ok: true; jid: string; name: string | null } | { ok: false; response: ReturnType<typeof error> } {
  if (result.type === "resolved") return { ok: true, jid: result.jid, name: result.name };
  if (result.type === "not_found") {
    return { ok: false, response: error("Geen contact/chat gevonden voor deze zoekopdracht.") };
  }
  const shown = result.candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
  const more = result.candidates.length - shown.length;
  return {
    ok: false,
    response: error(
      `Meerdere matches, wees specifieker of gebruik een JID/nummer:\n${shown
        .map((c) => `- ${c.name ?? "(onbekend)"} (${displayJid(c.jid)})`)
        .join("\n")}${more > 0 ? `\n… en ${more} meer` : ""}`
    ),
  };
}

function toEpochMs(input?: string): number | undefined {
  if (!input) return undefined;
  const ms = Date.parse(input);
  return Number.isNaN(ms) ? undefined : ms;
}

function snippet(value: string | null, max = 80): string {
  if (!value) return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Kapt lange berichtteksten af; bij een zoekopdracht wordt het venster rond
// de eerste match gecentreerd zodat de hit-tekst zichtbaar blijft.
function truncateBody(body: string, query?: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  let start = 0;
  if (query) {
    const idx = body.toLowerCase().indexOf(query.toLowerCase());
    if (idx >= 0) start = Math.max(0, Math.min(idx - Math.floor(MAX_BODY_CHARS / 2), body.length - MAX_BODY_CHARS));
  }
  const hidden = body.length - MAX_BODY_CHARS;
  return `${start > 0 ? "…" : ""}${body.slice(start, start + MAX_BODY_CHARS)}…[+${hidden} tekens; full_text=true]`;
}

function senderName(msg: db.MessageRow): string {
  return msg.from_me ? "Jij" : db.getDisplayName(msg.sender || msg.chat_jid);
}

interface MsgLineOpts {
  withChat?: boolean;
  withId?: boolean;
  withDate?: boolean;
  fullText?: boolean;
  query?: string;
}

// Eén bericht als compacte regel: "[21:53] Afzender: tekst". De datum komt
// uit dagkoppen (renderMessages); withDate is voor losstaande regels.
// Bericht-IDs alleen op verzoek of bij media, waar het ID nodig is voor
// download_media — IDs zijn lang en meestal irrelevant.
function msgLine(msg: db.MessageRow, opts: MsgLineOpts = {}): string {
  const stamp = opts.withDate ? fmtTime(msg.timestamp) : fmtClock(msg.timestamp);
  const chatPart = opts.withChat ? ` {${db.getDisplayName(msg.chat_jid)}}` : "";
  let meta = "";
  if (msg.type !== "text") {
    meta = ` <${msg.type} id=${msg.id}${msg.media_path ? ` pad=${msg.media_path}` : ""}>`;
  } else if (opts.withId) {
    meta = ` <id=${msg.id}>`;
  }
  const body = msg.text ? (opts.fullText ? msg.text : truncateBody(msg.text, opts.query)) : "";
  return `[${stamp}]${chatPart} ${senderName(msg)}: ${body}${meta}`;
}

// Chronologische lijst met een dagkop bij elke datumwissel; anchorId markeert
// het ankerbericht van get_message_context met ">>>".
function renderMessages(messages: db.MessageRow[], opts: MsgLineOpts & { anchorId?: string } = {}): string {
  const lines: string[] = [];
  let currentDay = "";
  for (const msg of messages) {
    const day = fmtDate(msg.timestamp);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(dayHeader(msg.timestamp));
    }
    const line = msgLine(msg, opts);
    lines.push(opts.anchorId && msg.id === opts.anchorId ? `>>> ${line}` : line);
  }
  return lines.join("\n");
}

function chatLine(chat: db.ChatRow): string {
  const name = db.getDisplayName(chat.jid);
  const id = displayJid(chat.jid);
  return `${name}${chat.is_group ? " (groep)" : ""}${id !== name ? ` — ${id}` : ""}`;
}

function lastMessageSummary(msg: db.MessageRow): string {
  const body = msg.text ? snippet(msg.text, 60) : `<${msg.type}>`;
  return `[${fmtTime(msg.timestamp)}] ${senderName(msg)}: ${body}`;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "get_current_time",
    {
      description:
        "Actuele datum en tijd (Europe/Amsterdam). Aanroepen vóór je een bericht schrijft met een tijdsverwijzing ('over 3 uur', 'morgenmiddag').",
      inputSchema: {},
    },
    async () => {
      const now = Date.now();
      return text(`Nu: ${weekdayLongFmt.format(now)} ${fmtTime(now)} (${TZ})\nISO (UTC): ${new Date(now).toISOString()}`);
    }
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Stuur een WhatsApp-tekstbericht. 'to' mag naam, nummer of JID zijn; namen worden automatisch opgezocht (search_contacts vooraf is onnodig). Tijdstip in de tekst? Bepaal dat via get_current_time of een Nu:-regel, niet uit je hoofd.",
      inputSchema: {
        to: z.string(),
        text: z.string(),
      },
    },
    async ({ to, text: body }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      await getSocket().sendMessage(resolved.jid, { text: body });
      return text(`Verzonden aan ${targetLabel(resolved.name, resolved.jid)} om ${fmtTime(Date.now())}.`);
    }
  );

  server.registerTool(
    "send_file",
    {
      description: "Stuur een afbeelding, video of document naar een contact of groep.",
      inputSchema: {
        to: z.string().describe("Naam, nummer of JID"),
        source: z.string().describe("Lokaal pad of URL"),
        caption: z.string().optional(),
      },
    },
    async ({ to, source, caption }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      await media.sendFile(resolved.jid, source, caption);
      return text(`Bestand verzonden aan ${targetLabel(resolved.name, resolved.jid)}: ${source}`);
    }
  );

  server.registerTool(
    "send_audio_message",
    {
      description: "Stuur audio als WhatsApp voice message (ptt); converteert zo nodig via ffmpeg naar ogg/opus.",
      inputSchema: {
        to: z.string().describe("Naam, nummer of JID"),
        source: z.string().describe("Lokaal pad of URL"),
      },
    },
    async ({ to, source }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      const result = await media.sendVoiceMessage(resolved.jid, source);
      const kind = result.sentAsVoiceNote ? "Voice-bericht" : "Audiobestand";
      return text(`${kind} verzonden aan ${targetLabel(resolved.name, resolved.jid)}.${result.note ? `\n${result.note}` : ""}`);
    }
  );

  server.registerTool(
    "download_media",
    {
      description:
        "Download media van een ontvangen bericht (id staat in de <type id=...>-annotatie). Afbeeldingen worden direct getoond, overige media als bestandspad.",
      inputSchema: {
        chat: z.string().describe("Naam, nummer of JID"),
        message_id: z.string(),
      },
    },
    async ({ chat, message_id }) => {
      const resolved = requireResolved(resolveChatTarget(chat));
      if (!resolved.ok) return resolved.response;
      try {
        const path = await media.downloadIncomingMedia(resolved.jid, message_id);
        const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
        if (mimeType) {
          const data = (await readFile(path)).toString("base64");
          return {
            content: [
              { type: "text" as const, text: `Afbeelding gedownload naar ${path}` },
              { type: "image" as const, data, mimeType },
            ],
          };
        }
        return text(`Opgeslagen: ${path}`);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "search_contacts",
    {
      description: "Zoek contacten op naam of telefoonnummer.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const rows = db.searchContacts(query);
      if (!rows.length) return text("Geen contacten gevonden.");
      return text(
        rows
          .map((c) => {
            const id = displayJid(c.jid);
            const extra = c.number && id !== c.number && !c.jid.startsWith(`${c.number}@`) ? ` (nummer: ${c.number})` : "";
            return `${c.name ?? "(onbekend)"} — ${id}${extra}`;
          })
          .join("\n")
      );
    }
  );

  server.registerTool(
    "list_chats",
    {
      description: "Toon recente chats (1-op-1 en groepen) met laatste bericht.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe("standaard 20"),
        include_groups: z.boolean().optional().describe("standaard true"),
      },
    },
    async ({ limit, include_groups }) => {
      const chats = db.getChats({ limit, includeGroups: include_groups });
      if (!chats.length) return text(`${nowLine()}\nGeen chats gevonden.`);
      const lines = chats.map((chat) => {
        const last = db.getLastInteraction(chat.jid);
        return `${chatLine(chat)}${last ? `\n  ${lastMessageSummary(last)}` : ""}`;
      });
      return text(`${nowLine()}\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "Zoek/filter berichten; zonder 'chat' wordt over alle chats gezocht ({chatnaam} per regel). Datums als ISO-string (bv. 2026-07-01).",
      inputSchema: {
        chat: z.string().optional().describe("Beperk tot één chat (naam, nummer of JID)"),
        query: z.string().optional().describe("Zoektekst"),
        sender: z.string().optional().describe("Afzender-JID"),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        is_from_me: z.boolean().optional().describe("true=eigen, false=ontvangen"),
        limit: z.number().int().positive().max(500).optional().describe("standaard 20"),
        include_ids: z.boolean().optional().describe("Toon bericht-IDs (voor get_message_context/download_media)"),
        full_text: z.boolean().optional().describe(`Geen afkapping op ${MAX_BODY_CHARS} tekens`),
      },
    },
    async ({ chat, query, sender, date_from, date_to, is_from_me, limit, include_ids, full_text }) => {
      let chatJid: string | undefined;
      if (chat) {
        const resolved = requireResolved(resolveChatTarget(chat));
        if (!resolved.ok) return resolved.response;
        chatJid = resolved.jid;
      }
      const messages = db
        .getMessages({
          chatJid,
          query,
          sender,
          dateFrom: toEpochMs(date_from),
          dateTo: toEpochMs(date_to),
          isFromMe: is_from_me,
          limit,
        })
        .reverse(); // chronologisch, oudste eerst
      if (!messages.length) return text(`${nowLine()}\nGeen berichten gevonden.`);
      const header = chatJid
        ? `Chat: ${targetLabel(db.getDisplayName(chatJid), chatJid)} — ${messages.length} berichten`
        : `${messages.length} berichten uit meerdere chats`;
      const body = renderMessages(messages, {
        withChat: !chatJid,
        withId: include_ids ?? false,
        fullText: full_text ?? false,
        query,
      });
      return text(`${nowLine()}\n${header}\n${body}`);
    }
  );

  server.registerTool(
    "get_message_context",
    {
      description: "Haal berichten rond een specifiek bericht op (voor/na), om conversatiecontext te zien.",
      inputSchema: {
        chat: z.string().describe("Naam, nummer of JID"),
        message_id: z.string(),
        before: z.number().int().min(0).max(50).optional().describe("standaard 5"),
        after: z.number().int().min(0).max(50).optional().describe("standaard 5"),
        include_ids: z.boolean().optional().describe("Toon bericht-IDs"),
        full_text: z.boolean().optional().describe(`Geen afkapping op ${MAX_BODY_CHARS} tekens`),
      },
    },
    async ({ chat, message_id, before, after, include_ids, full_text }) => {
      const resolved = requireResolved(resolveChatTarget(chat));
      if (!resolved.ok) return resolved.response;
      const context = db.getMessageContext(resolved.jid, message_id, before, after);
      if (!context) return error("Bericht niet gevonden in de lokale geschiedenis.");
      const body = renderMessages([...context.before, context.message, ...context.after], {
        withId: include_ids ?? false,
        fullText: full_text ?? false,
        anchorId: context.message.id,
      });
      return text(`${nowLine()}\nChat: ${targetLabel(db.getDisplayName(resolved.jid), resolved.jid)}\n${body}`);
    }
  );

  server.registerTool(
    "get_last_interaction",
    {
      description: "Haal het meest recente bericht met een contact of groep op.",
      inputSchema: { contact: z.string().describe("Naam, nummer of JID") },
    },
    async ({ contact }) => {
      const resolved = requireResolved(resolveChatTarget(contact));
      if (!resolved.ok) return resolved.response;
      const last = db.getLastInteraction(resolved.jid);
      if (!last) return text(`${nowLine()}\nGeen berichten met ${targetLabel(resolved.name, resolved.jid)}.`);
      return text(`${nowLine()}\n${msgLine(last, { withChat: true, withId: true, withDate: true, fullText: true })}`);
    }
  );

  server.registerTool(
    "get_direct_chat_by_contact",
    {
      description: "Vind het 1-op-1 gesprek met een specifiek contact.",
      inputSchema: { contact: z.string().describe("Naam, nummer of JID") },
    },
    async ({ contact }) => {
      const resolved = requireResolved(resolveChatTarget(contact, { directOnly: true }));
      if (!resolved.ok) return resolved.response;
      return text(targetLabel(db.getDisplayName(resolved.jid), resolved.jid));
    }
  );

  server.registerTool(
    "get_contact_chats",
    {
      description: "Lijst alle chats (1-op-1 en groepen) waarin dit contact voorkomt.",
      inputSchema: { contact: z.string().describe("Naam, nummer of JID") },
    },
    async ({ contact }) => {
      const resolved = requireResolved(resolveChatTarget(contact, { directOnly: true }));
      if (!resolved.ok) return resolved.response;
      const chats = db.getChatsForSender(resolved.jid);
      if (!chats.length) return text("Geen chats gevonden voor dit contact.");
      return text(chats.map(chatLine).join("\n"));
    }
  );

  server.registerTool(
    "list_groups",
    { description: "Toon alle groepschats.", inputSchema: {} },
    async () => {
      const groups = db.getGroups();
      if (!groups.length) return text("Geen groepen gevonden.");
      return text(groups.map((g) => `${db.getDisplayName(g.jid)} — ${g.jid}`).join("\n"));
    }
  );

  server.registerTool(
    "get_group_info",
    {
      description: "Haal live groepsinformatie op: leden, admins, omschrijving.",
      inputSchema: {
        group: z.string().describe("Naam of JID van de groep"),
        include_jids: z.boolean().optional().describe("Toon leden-JIDs (standaard false)"),
        members_limit: z.number().int().positive().optional().describe("standaard 100"),
      },
    },
    async ({ group, include_jids, members_limit }) => {
      const resolved = requireResolved(resolveChatTarget(group, { groupOnly: true }));
      if (!resolved.ok) return resolved.response;
      try {
        const metadata = await getSocket().groupMetadata(resolved.jid);
        const limit = members_limit ?? 100;
        const participants = metadata.participants;
        const names = participants
          .slice(0, limit)
          .map(
            (p) =>
              `${db.getDisplayName(p.id)}${include_jids ? ` (${displayJid(p.id)})` : ""}${p.admin ? ` [${p.admin}]` : ""}`
          );
        const overflow = participants.length > limit ? ` (+${participants.length - limit} meer)` : "";
        const lines = [
          `${metadata.subject} — ${resolved.jid}`,
          ...(metadata.desc ? [`Omschrijving: ${snippet(metadata.desc, 200)}`] : []),
          `Leden (${participants.length}): ${names.join(", ")}${overflow}`,
        ];
        return text(lines.join("\n"));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_unanswered_messages",
    {
      description:
        "1-op-1 chats waarvan het laatste inkomende bericht langer dan de drempel onbeantwoord is; filtert standaard op vraag-achtige berichten.",
      inputSchema: {
        threshold_minutes: z.number().int().positive().optional().describe("standaard 30"),
        max_age_days: z.number().int().positive().optional().describe("standaard 30"),
        require_question: z.boolean().optional().describe("standaard true"),
      },
    },
    async ({ threshold_minutes, max_age_days, require_question }) => {
      const chats = db.getUnansweredChats(threshold_minutes ?? 30, max_age_days ?? 30, require_question ?? true);
      if (!chats.length) return text(`${nowLine()}\nGeen onbeantwoorde berichten.`);
      const lines = chats.map((c) => {
        const last = db.getLastInteraction(c.jid);
        return `${targetLabel(db.getDisplayName(c.jid), c.jid)}${
          last ? ` — [${fmtTime(last.timestamp)}] ${snippet(last.text, 100)}` : ""
        }`;
      });
      return text(`${nowLine()}\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "check_connection_status",
    { description: "Controleer of de WhatsApp-verbinding actief is.", inputSchema: {} },
    async () => {
      const s = getStatus();
      return text(
        `${nowLine()}\nVerbinding: ${s.connectionState}${s.linkedNumber ? ` — gekoppeld als ${s.linkedNumber}` : ""}${
          s.lastConnectedAt ? ` (sinds ${fmtTime(s.lastConnectedAt)})` : ""
        }`
      );
    }
  );
}
