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

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
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

function formatChat(chat: db.ChatRow) {
  return { jid: chat.jid, name: db.getDisplayName(chat.jid), is_group: !!chat.is_group };
}

function formatMessage(msg: db.MessageRow) {
  return {
    chat: db.getDisplayName(msg.chat_jid),
    chat_jid: msg.chat_jid,
    id: msg.id,
    from_me: !!msg.from_me,
    sender: msg.from_me ? "Jij" : msg.sender ? db.getDisplayName(msg.sender) : db.getDisplayName(msg.chat_jid),
    text: msg.text,
    type: msg.type,
    media_path: msg.media_path,
    timestamp: msg.timestamp,
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "send_message",
    {
      description: "Stuur een WhatsApp-tekstbericht naar een contact of groep (op naam, nummer, of JID).",
      inputSchema: {
        to: z.string().describe("Naam, telefoonnummer of JID van de ontvanger"),
        text: z.string().describe("De berichttekst"),
      },
    },
    async ({ to, text }) => {
      const resolved = requireResolved(resolveChatTarget(to));
      if (!resolved.ok) return resolved.response;
      await getSocket().sendMessage(resolved.jid, { text });
      return json({ sent: true, to: resolved.jid, name: resolved.name });
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
      return json({ sent: true, to: resolved.jid, name: resolved.name, source });
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
      return json({ sent: true, to: resolved.jid, name: resolved.name, ...result });
    }
  );

  server.registerTool(
    "download_media",
    {
      description:
        "Download media van een ontvangen bericht naar schijf. Afbeeldingen worden ook direct in het resultaat getoond; video/audio/documenten alleen als bestandspad.",
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
        return json({ path });
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
    async ({ query }) => json(db.searchContacts(query))
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
      return json(
        chats.map((chat) => {
          const lastMessage = db.getLastInteraction(chat.jid);
          return { ...formatChat(chat), last_message: lastMessage ? formatMessage(lastMessage) : null };
        })
      );
    }
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "Zoek/filter berichten. Zonder 'chat' wordt over alle chats gezocht. Datums als ISO-string (bv. 2026-07-01).",
      inputSchema: {
        chat: z.string().optional().describe("Naam, telefoonnummer of JID om tot één chat te beperken"),
        query: z.string().optional().describe("Tekst om op te zoeken in berichten"),
        sender: z.string().optional().describe("JID van de afzender om op te filteren"),
        date_from: z.string().optional().describe("ISO-datum, alleen berichten vanaf hier"),
        date_to: z.string().optional().describe("ISO-datum, alleen berichten tot hier"),
        is_from_me: z.boolean().optional().describe("Alleen eigen (true) of ontvangen (false) berichten"),
        limit: z.number().int().positive().max(500).optional().describe("Maximum aantal berichten (standaard 20)"),
      },
    },
    async ({ chat, query, sender, date_from, date_to, is_from_me, limit }) => {
      let chatJid: string | undefined;
      if (chat) {
        const resolved = requireResolved(resolveChatTarget(chat));
        if (!resolved.ok) return resolved.response;
        chatJid = resolved.jid;
      }
      const messages = db.getMessages({
        chatJid,
        query,
        sender,
        dateFrom: toEpochMs(date_from),
        dateTo: toEpochMs(date_to),
        isFromMe: is_from_me,
        limit,
      });
      return json(messages.map(formatMessage));
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
      return json({
        before: context.before.map(formatMessage),
        message: formatMessage(context.message),
        after: context.after.map(formatMessage),
      });
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
      return json(last ? formatMessage(last) : null);
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
      const chat = db.getChat(resolved.jid);
      return json(chat ? formatChat(chat) : { jid: resolved.jid, name: db.getDisplayName(resolved.jid), is_group: false });
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
      return json(db.getChatsForSender(resolved.jid).map(formatChat));
    }
  );

  server.registerTool(
    "list_groups",
    { description: "Toon alle groepschats.", inputSchema: {} },
    async () => json(db.getGroups().map(formatChat))
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
        return json({
          ...metadata,
          participants: metadata.participants.map((p) => ({ ...p, name: db.getDisplayName(p.id) })),
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_unanswered_messages",
    {
      description:
        "Toon 1-op-1 chats waarin het laatste bericht inkomend is en al langer dan de drempel onbeantwoord staat (groepen worden genegeerd). Chats waarvan het laatste bericht ouder is dan max_age_days worden als niet meer relevant beschouwd en weggelaten (anders domineren jarenoude, allang dode gesprekken de resultaten).",
      inputSchema: {
        threshold_minutes: z.number().int().positive().optional().describe("Drempel in minuten (standaard 30)"),
        max_age_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Negeer chats waarvan het laatste bericht ouder is dan dit (standaard 30 dagen)"),
      },
    },
    async ({ threshold_minutes, max_age_days }) =>
      json(db.getUnansweredChats(threshold_minutes ?? 30, max_age_days ?? 30).map(formatChat))
  );

  server.registerTool(
    "check_connection_status",
    { description: "Controleer of de WhatsApp-verbinding actief is.", inputSchema: {} },
    async () => json(getStatus())
  );
}
