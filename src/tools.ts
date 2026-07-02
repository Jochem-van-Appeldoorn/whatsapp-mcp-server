import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveChatTarget, type ResolveResult } from "./contacts.js";
import * as db from "./db.js";
import * as media from "./media.js";
import { getSocket, getStatus } from "./whatsapp.js";

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
      description: "Download media van een ontvangen bericht naar schijf en geef het lokale bestandspad terug.",
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
        chats.map((chat) => ({
          jid: chat.jid,
          name: chat.name,
          is_group: !!chat.is_group,
          last_message: db.getLastInteraction(chat.jid),
        }))
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
      return json(
        db.getMessages({
          chatJid,
          query,
          sender,
          dateFrom: toEpochMs(date_from),
          dateTo: toEpochMs(date_to),
          isFromMe: is_from_me,
          limit,
        })
      );
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
      return json(context);
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
      return json(db.getLastInteraction(resolved.jid) ?? null);
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
      return json(db.getChat(resolved.jid) ?? { jid: resolved.jid, name: resolved.name });
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
      return json(db.getChatsForSender(resolved.jid));
    }
  );

  server.registerTool(
    "list_groups",
    { description: "Toon alle groepschats.", inputSchema: {} },
    async () => json(db.getGroups())
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
        return json(metadata);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_unanswered_messages",
    {
      description:
        "Toon 1-op-1 chats waarin het laatste bericht inkomend is en al langer dan de drempel onbeantwoord staat (groepen worden genegeerd).",
      inputSchema: {
        threshold_minutes: z.number().int().positive().optional().describe("Drempel in minuten (standaard 30)"),
      },
    },
    async ({ threshold_minutes }) => json(db.getUnansweredChats(threshold_minutes ?? 30))
  );

  server.registerTool(
    "check_connection_status",
    { description: "Controleer of de WhatsApp-verbinding actief is.", inputSchema: {} },
    async () => json(getStatus())
  );
}
