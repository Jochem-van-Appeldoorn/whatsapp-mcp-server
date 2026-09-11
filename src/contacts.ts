import { getDisplayName, searchChatsByName, searchContacts as searchContactsDb, accountsForChat } from "./db.js";

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
 *
 * Met `account` wordt er alleen gezocht in wat dat nummer kent. Dat is nodig
 * bij verzenden: een groep die alleen op het privénummer bestaat mag niet
 * opeens als doel gelden voor een bericht vanaf het Claude-nummer.
 */
export function resolveChatTarget(
  input: string,
  opts: { groupOnly?: boolean; directOnly?: boolean; account?: string } = {}
): ResolveResult {
  const trimmed = input.trim();

  if (isJid(trimmed)) {
    return { type: "resolved", jid: trimmed, name: getDisplayName(trimmed, opts.account) };
  }

  if (!opts.groupOnly && looksLikePhoneNumber(trimmed)) {
    const jid = phoneToJid(trimmed);
    return { type: "resolved", jid, name: getDisplayName(jid, opts.account) };
  }

  const candidates = new Map<string, string | null>();

  if (!opts.directOnly) {
    for (const chat of searchChatsByName(trimmed, true, opts.account)) {
      candidates.set(chat.jid, chat.name);
    }
  }
  if (!opts.groupOnly) {
    for (const contact of searchContactsDb(trimmed, opts.account)) {
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

/** Accounts waarop deze chat voorkomt, om te tonen waar iets vandaan komt. */
export function chatAccounts(jid: string): string[] {
  return accountsForChat(jid);
}
