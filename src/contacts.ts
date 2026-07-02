import { getDisplayName, searchChatsByName, searchContacts as searchContactsDb } from "./db.js";

export type ResolveResult =
  | { type: "resolved"; jid: string; name: string | null }
  | { type: "ambiguous"; candidates: { jid: string; name: string | null }[] }
  | { type: "not_found" };

export function isJid(input: string): boolean {
  return input.includes("@s.whatsapp.net") || input.includes("@g.us") || input.includes("@lid");
}

function looksLikePhoneNumber(input: string): boolean {
  return /^[\d+\s()-]{8,}$/.test(input.trim());
}

export function phoneToJid(input: string): string {
  const digits = input.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Resolves free-form input (JID, phone number, or a name to fuzzy-match
 * against contacts/group names) to a single WhatsApp JID.
 */
export function resolveChatTarget(input: string, opts: { groupOnly?: boolean; directOnly?: boolean } = {}): ResolveResult {
  const trimmed = input.trim();

  if (isJid(trimmed)) {
    return { type: "resolved", jid: trimmed, name: getDisplayName(trimmed) };
  }

  if (!opts.groupOnly && looksLikePhoneNumber(trimmed)) {
    const jid = phoneToJid(trimmed);
    return { type: "resolved", jid, name: getDisplayName(jid) };
  }

  const candidates = new Map<string, string | null>();

  if (!opts.directOnly) {
    for (const chat of searchChatsByName(trimmed, true)) {
      candidates.set(chat.jid, chat.name);
    }
  }
  if (!opts.groupOnly) {
    for (const contact of searchContactsDb(trimmed)) {
      candidates.set(contact.jid, contact.name);
    }
  }

  if (candidates.size === 0) return { type: "not_found" };
  if (candidates.size === 1) {
    const [[jid, name]] = candidates;
    return { type: "resolved", jid, name };
  }
  return {
    type: "ambiguous",
    candidates: [...candidates].map(([jid, name]) => ({ jid, name })),
  };
}
