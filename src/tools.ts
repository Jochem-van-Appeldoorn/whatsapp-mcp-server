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

// sv-SE levert "2026-07-02 14:35" (ISO-achtig, 24-uurs), altijd in TZ —
// onafhankelijk van de systeem-tijdzone waar de server draait.
const timestampFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const weekdayFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, weekday: "long" });

function fmtTime(epochMs: number): string {
  return timestampFmt.format(new Date(epochMs));
}

function nowLine(): string {
  const now = Date.now();
  return `Nu: ${weekdayFmt.format(now)} ${fmtTime(now)} (${TZ})`;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function requireResolved(
  result: ResolveResult
): { ok: true; jid: string; name: string | null } | { ok: false; response: ReturnType<typeof error> } {
  if (result.type === "resolved") return { ok: true, jid: result.jid, name: result.name };
  if (result.type === "not_found") {
    return { ok: false, response: error("Geen contact/chat gevonden voor deze zoekopdracht.") };
  }
  return {
    ok: false,
    response: error(
      `Meerdere mogelijke matches gevonden, wees specifieker of gebruik een JID/nummer:\n${result.candidates
        .map((c) => `- ${c.name ?? "(onbekend)"} (${c.jid})`)
        .join("\n")}`
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

function senderName(msg: db.MessageRow): string {
  return msg.from_me ? "Jij" : db.getDisplayName(msg.sender || msg.chat_jid);
}

// Eén bericht als compacte regel: "[2026-07-02 14:35] Afzender: tekst".
// Bericht-IDs alleen op verzoek (withId) of bij media, waar het ID nodig is
// voor download_media — IDs zijn lang en meestal irrelevant.
function msgLine(msg: db.MessageRow, opts: { withChat?: boolean; withId?: boolean } = {}): string {
  const chatPart = opts.withChat ? ` {${db.getDisplayName(msg.chat_jid)}}` : "";
  let meta = "";
  if (msg.type !== "text") {
    meta = ` <${msg.type} id=${msg.id}${msg.media_path ? ` pad=${msg.media_path}` : ""}>`;
  } else if (opts.withId) {
    meta = ` <id=${msg.id}>`;
  }
  return `[${fmtTime(msg.timestamp)}]${chatPart} ${senderName(msg)}: ${msg.text ?? ""}${meta}`;
}

function chatLine(chat: db.ChatRow): string {
  return `${db.getDisplayName(chat.jid)}${chat.is_group ? " (groep)" : ""} — ${chat.jid}`;
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
        "Actuele datum en tijd (Europe/Amsterdam). Roep dit aan vóór je een bericht schrijft met een tijdsverwijzing ('over 3 uur', 'morgenmiddag') of een tijdsverschil uitrekent.",
      inputSchema: {},
    },
    async () => text(`${nowLine()}\nISO (UTC): ${new Date().toISOString()}`)
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Stuur een WhatsApp-tekstbericht. 'to' mag naam, nummer of JID zijn; namen worden automatisch opgezocht (search_contacts vooraf is onnodig). Noem je een tijdstip in de tekst, bepaal dat dan vanuit get_current_time of een 'Nu:'-regel, niet uit je hoofd.",
      inputSchema: {
        to: z.string().describe("Naam, telefoonnummer of JID van de ontvanger"),
        text: z.string().describe("De berichttekst"),
      },
    },
    async ({ to, text: body }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      await getSocket().sendMessage(resolved.jid, { text: body });
      return text(`Verzonden aan ${resolved.name ?? resolved.jid} (${resolved.jid}) om ${fmtTime(Date.now())}.`);
    }
  );

  server.registerTool(
    "send_file",
    {
      description: "Stuur een afbeelding, video of document naar een contact of groep (lokaal pad of URL).",
      inputSchema: {
        to: z.string().describe("Naam, telefoonnummer of JID van de ontvanger"),
        source: z.string().describe("Lokaal bestandspad of URL"),
        caption: z.string().optional().describe("Optioneel bijschrift"),
      },
    },
    async ({ to, source, caption }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      await media.sendFile(resolved.jid, source, caption);
      return text(`Bestand verzonden aan ${resolved.name ?? resolved.jid} (${resolved.jid}): ${source}`);
    }
  );

  server.registerTool(
    "send_audio_message",
    {
      description:
        "Stuur audio als WhatsApp voice message (ptt). Converteert automatisch naar ogg/opus met ffmpeg indien nodig en beschikbaar.",
      inputSchema: {
        to: z.string().describe("Naam, telefoonnummer of JID van de ontvanger"),
        source: z.string().describe("Lokaal bestandspad of URL naar het audiobestand"),
      },
    },
    async ({ to, source }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      const result = await media.sendVoiceMessage(resolved.jid, source);
      const kind = result.sentAsVoiceNote ? "Voice-bericht" : "Audiobestand";
      return text(
        `${kind} verzonden aan ${resolved.name ?? resolved.jid} (${resolved.jid}).${result.note ? `\n${result.note}` : ""}`
      );
    }
  );

  server.registerTool(
    "download_media",
    {
      description:
        "Download media van een ontvangen bericht (bericht-ID staat in de <type id=...>-annotatie). Afbeeldingen worden direct getoond, overige media als bestandspad.",
      inputSchema: {
        chat: z.string().describe("Naam, telefoonnummer of JID van de chat waarin het bericht staat"),
        message_id: z.string().describe("Het bericht-ID van het mediabericht"),
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
      inputSchema: { query: z.string().describe("Zoekterm (deel van naam of nummer)") },
    },
    async ({ query }) => {
      const rows = db.searchContacts(query);
      if (!rows.length) return text("Geen contacten gevonden.");
      return text(
        rows
          .map(
            (c) =>
              `${c.name ?? "(onbekend)"} — ${c.jid}${
                c.number && !c.jid.startsWith(`${c.number}@`) ? ` (nummer: ${c.number})` : ""
              }`
          )
          .join("\n")
      );
    }
  );

  server.registerTool(
    "list_chats",
    {
      description: "Toon recente chats (1-op-1 en groepen) met laatste bericht.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe("Maximum aantal chats (standaard 20)"),
        include_groups: z.boolean().optional().describe("Groepen meenemen (standaard true)"),
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
        "Zoek/filter berichten. Zonder 'chat' wordt over alle chats gezocht ({chatnaam} per regel). Datums als ISO-string (bv. 2026-07-01).",
      inputSchema: {
        chat: z.string().optional().describe("Naam, telefoonnummer of JID om tot één chat te beperken"),
        query: z.string().optional().describe("Tekst om op te zoeken in berichten"),
        sender: z.string().optional().describe("JID van de afzender om op te filteren"),
        date_from: z.string().optional().describe("ISO-datum, alleen berichten vanaf hier"),
        date_to: z.string().optional().describe("ISO-datum, alleen berichten tot hier"),
        is_from_me: z.boolean().optional().describe("Alleen eigen (true) of ontvangen (false) berichten"),
        limit: z.number().int().positive().max(500).optional().describe("Maximum aantal berichten (standaard 20)"),
        include_ids: z
          .boolean()
          .optional()
          .describe("Toon bericht-IDs (nodig voor get_message_context/download_media; standaard false)"),
      },
    },
    async ({ chat, query, sender, date_from, date_to, is_from_me, limit, include_ids }) => {
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
        ? `Chat: ${db.getDisplayName(chatJid)} (${chatJid}) — ${messages.length} berichten, oudste eerst`
        : `${messages.length} berichten uit meerdere chats, oudste eerst`;
      const lines = messages.map((m) => msgLine(m, { withChat: !chatJid, withId: include_ids ?? false }));
      return text(`${nowLine()}\n${header}\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "get_message_context",
    {
      description: "Haal berichten rond een specifiek bericht op (voor/na), om conversatiecontext te zien.",
      inputSchema: {
        chat: z.string().describe("Naam, telefoonnummer of JID van de chat"),
        message_id: z.string().describe("Het bericht-ID waar rond gezocht wordt"),
        before: z.number().int().min(0).max(50).optional().describe("Aantal berichten ervoor (standaard 5)"),
        after: z.number().int().min(0).max(50).optional().describe("Aantal berichten erna (standaard 5)"),
      },
    },
    async ({ chat, message_id, before, after }) => {
      const resolved = requireResolved(resolveChatTarget(chat));
      if (!resolved.ok) return resolved.response;
      const context = db.getMessageContext(resolved.jid, message_id, before, after);
      if (!context) return error("Bericht niet gevonden in de lokale geschiedenis.");
      const lines = [
        ...context.before.map((m) => msgLine(m, { withId: true })),
        `>>> ${msgLine(context.message, { withId: true })}`,
        ...context.after.map((m) => msgLine(m, { withId: true })),
      ];
      return text(
        `${nowLine()}\nChat: ${db.getDisplayName(resolved.jid)} (${resolved.jid}), oudste eerst\n${lines.join("\n")}`
      );
    }
  );

  server.registerTool(
    "get_last_interaction",
    {
      description: "Haal het meest recente bericht met een contact of groep op.",
      inputSchema: { contact: z.string().describe("Naam, telefoonnummer of JID") },
    },
    async ({ contact }) => {
      const resolved = requireResolved(resolveChatTarget(contact));
      if (!resolved.ok) return resolved.response;
      const last = db.getLastInteraction(resolved.jid);
      if (!last) return text(`${nowLine()}\nGeen berichten met ${resolved.name ?? resolved.jid}.`);
      return text(`${nowLine()}\n${msgLine(last, { withChat: true, withId: true })}`);
    }
  );

  server.registerTool(
    "get_direct_chat_by_contact",
    {
      description: "Vind het 1-op-1 gesprek met een specifiek contact.",
      inputSchema: { contact: z.string().describe("Naam, telefoonnummer of JID") },
    },
    async ({ contact }) => {
      const resolved = requireResolved(resolveChatTarget(contact, { directOnly: true }));
      if (!resolved.ok) return resolved.response;
      return text(`${db.getDisplayName(resolved.jid)} — ${resolved.jid}`);
    }
  );

  server.registerTool(
    "get_contact_chats",
    {
      description: "Lijst alle chats (1-op-1 en groepen) waarin dit contact voorkomt.",
      inputSchema: { contact: z.string().describe("Naam, telefoonnummer of JID") },
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
      inputSchema: { group: z.string().describe("Naam of JID van de groep") },
    },
    async ({ group }) => {
      const resolved = requireResolved(resolveChatTarget(group, { groupOnly: true }));
      if (!resolved.ok) return resolved.response;
      try {
        const metadata = await getSocket().groupMetadata(resolved.jid);
        const lines = [
          `${metadata.subject} — ${resolved.jid}`,
          ...(metadata.desc ? [`Omschrijving: ${snippet(metadata.desc, 200)}`] : []),
          `${metadata.participants.length} leden:`,
          ...metadata.participants.map(
            (p) => `- ${db.getDisplayName(p.id)} (${p.id})${p.admin ? ` [${p.admin}]` : ""}`
          ),
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
        "Toon 1-op-1 chats waarvan het laatste inkomende bericht langer dan de drempel onbeantwoord is. Filtert standaard op vraag-achtige berichten en negeert chats ouder dan max_age_days.",
      inputSchema: {
        threshold_minutes: z.number().int().positive().optional().describe("Drempel in minuten (standaard 30)"),
        max_age_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Negeer chats waarvan het laatste bericht ouder is dan dit (standaard 30 dagen)"),
        require_question: z
          .boolean()
          .optional()
          .describe("Alleen berichten die op een vraag lijken meetellen (standaard true)"),
      },
    },
    async ({ threshold_minutes, max_age_days, require_question }) => {
      const chats = db.getUnansweredChats(threshold_minutes ?? 30, max_age_days ?? 30, require_question ?? true);
      if (!chats.length) return text(`${nowLine()}\nGeen onbeantwoorde berichten.`);
      const lines = chats.map((c) => {
        const last = db.getLastInteraction(c.jid);
        return `${db.getDisplayName(c.jid)} (${c.jid})${
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
