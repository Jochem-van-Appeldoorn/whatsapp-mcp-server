import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_ts INTEGER,
    last_notified_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    sender TEXT,
    text TEXT,
    type TEXT NOT NULL DEFAULT 'text',
    media_path TEXT,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp);

  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    name TEXT,
    number TEXT
  );

  CREATE TABLE IF NOT EXISTS media_messages (
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    raw BLOB NOT NULL,
    PRIMARY KEY (chat_jid, id)
  );
`);

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_message_ts: number | null;
  last_notified_ts: number | null;
}

export interface MessageRow {
  chat_jid: string;
  id: string;
  from_me: number;
  sender: string | null;
  text: string | null;
  type: string;
  media_path: string | null;
  timestamp: number;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  number: string | null;
}

const upsertChatStmt = db.prepare(`
  INSERT INTO chats (jid, name, is_group, last_message_ts)
  VALUES (@jid, @name, @is_group, @last_message_ts)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group,
    last_message_ts = MAX(COALESCE(excluded.last_message_ts, 0), COALESCE(chats.last_message_ts, 0))
`);

export function upsertChat(jid: string, name: string | null, isGroup: boolean, lastMessageTs: number | null) {
  upsertChatStmt.run({ jid, name, is_group: isGroup ? 1 : 0, last_message_ts: lastMessageTs });
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, name, number)
  VALUES (@jid, @name, @number)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, contacts.name),
    number = COALESCE(excluded.number, contacts.number)
`);

export function upsertContact(jid: string, name: string | null, number: string | null) {
  upsertContactStmt.run({ jid, name, number });
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (chat_jid, id, from_me, sender, text, type, media_path, timestamp)
  VALUES (@chat_jid, @id, @from_me, @sender, @text, @type, @media_path, @timestamp)
  ON CONFLICT(chat_jid, id) DO UPDATE SET
    text = COALESCE(excluded.text, messages.text),
    media_path = COALESCE(excluded.media_path, messages.media_path)
`);

export function insertMessage(msg: MessageRow) {
  insertMessageStmt.run(msg);
  upsertChatStmt.run({ jid: msg.chat_jid, name: null, is_group: msg.chat_jid.endsWith("@g.us") ? 1 : 0, last_message_ts: msg.timestamp });
}

export function getChats(opts: { limit?: number; includeGroups?: boolean } = {}): ChatRow[] {
  const limit = opts.limit ?? 20;
  const includeGroups = opts.includeGroups ?? true;
  const sql = includeGroups
    ? `SELECT * FROM chats ORDER BY last_message_ts DESC LIMIT ?`
    : `SELECT * FROM chats WHERE is_group = 0 ORDER BY last_message_ts DESC LIMIT ?`;
  return db.prepare(sql).all(limit) as ChatRow[];
}

export function getChat(jid: string): ChatRow | undefined {
  return db.prepare(`SELECT * FROM chats WHERE jid = ?`).get(jid) as ChatRow | undefined;
}

export function getGroups(): ChatRow[] {
  return db.prepare(`SELECT * FROM chats WHERE is_group = 1 ORDER BY last_message_ts DESC`).all() as ChatRow[];
}

export function searchChatsByName(query: string, isGroup?: boolean): ChatRow[] {
  const like = `%${query}%`;
  const sql =
    isGroup === undefined
      ? `SELECT * FROM chats WHERE name LIKE @like ORDER BY last_message_ts DESC LIMIT 20`
      : `SELECT * FROM chats WHERE name LIKE @like AND is_group = @isGroup ORDER BY last_message_ts DESC LIMIT 20`;
  return db.prepare(sql).all({ like, isGroup: isGroup ? 1 : 0 }) as ChatRow[];
}

export function getMessages(opts: {
  chatJid?: string;
  query?: string;
  sender?: string;
  dateFrom?: number;
  dateTo?: number;
  isFromMe?: boolean;
  limit?: number;
}): MessageRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.chatJid) {
    clauses.push("chat_jid = @chatJid");
    params.chatJid = opts.chatJid;
  }
  if (opts.query) {
    clauses.push("text LIKE @query");
    params.query = `%${opts.query}%`;
  }
  if (opts.sender) {
    clauses.push("sender = @sender");
    params.sender = opts.sender;
  }
  if (opts.dateFrom) {
    clauses.push("timestamp >= @dateFrom");
    params.dateFrom = opts.dateFrom;
  }
  if (opts.dateTo) {
    clauses.push("timestamp <= @dateTo");
    params.dateTo = opts.dateTo;
  }
  if (opts.isFromMe !== undefined) {
    clauses.push("from_me = @isFromMe");
    params.isFromMe = opts.isFromMe ? 1 : 0;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.limit = opts.limit ?? 20;
  return db
    .prepare(`SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT @limit`)
    .all(params) as MessageRow[];
}

export function getMessageContext(chatJid: string, messageId: string, before = 5, after = 5) {
  const anchor = db
    .prepare(`SELECT * FROM messages WHERE chat_jid = ? AND id = ?`)
    .get(chatJid, messageId) as MessageRow | undefined;
  if (!anchor) return undefined;
  const beforeRows = db
    .prepare(`SELECT * FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`)
    .all(chatJid, anchor.timestamp, before) as MessageRow[];
  const afterRows = db
    .prepare(`SELECT * FROM messages WHERE chat_jid = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`)
    .all(chatJid, anchor.timestamp, after) as MessageRow[];
  return { before: beforeRows.reverse(), message: anchor, after: afterRows };
}

export function getLastInteraction(chatJid: string): MessageRow | undefined {
  return db
    .prepare(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(chatJid) as MessageRow | undefined;
}

export function getChatsForSender(jid: string): ChatRow[] {
  return db
    .prepare(
      `SELECT DISTINCT c.* FROM chats c
       WHERE c.jid = @jid
          OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_jid = c.jid AND m.sender = @jid)
       ORDER BY c.last_message_ts DESC`
    )
    .all({ jid }) as ChatRow[];
}

export function searchContacts(query: string): ContactRow[] {
  const like = `%${query}%`;
  return db
    .prepare(`SELECT * FROM contacts WHERE name LIKE @like OR number LIKE @like ORDER BY name LIMIT 20`)
    .all({ like }) as ContactRow[];
}

export function getContact(jid: string): ContactRow | undefined {
  return db.prepare(`SELECT * FROM contacts WHERE jid = ?`).get(jid) as ContactRow | undefined;
}

/**
 * Best-effort display name for a JID: contact name, then chat name
 * (group subject), falling back to the bare phone number/id.
 */
export function getDisplayName(jid: string): string {
  const contact = getContact(jid);
  if (contact?.name) return contact.name;
  const chat = getChat(jid);
  if (chat?.name) return chat.name;
  return jid.split("@")[0];
}

export function getUnansweredChats(thresholdMinutes: number): ChatRow[] {
  const cutoff = Date.now() - thresholdMinutes * 60_000;
  return db
    .prepare(
      `SELECT c.* FROM chats c
       WHERE c.is_group = 0
         AND c.last_message_ts IS NOT NULL
         AND c.last_message_ts <= @cutoff
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.chat_jid = c.jid AND m.timestamp = c.last_message_ts AND m.from_me = 0
         )
       ORDER BY c.last_message_ts ASC`
    )
    .all({ cutoff }) as ChatRow[];
}

export function markChatNotified(jid: string, ts: number) {
  db.prepare(`UPDATE chats SET last_notified_ts = ? WHERE jid = ?`).run(ts, jid);
}

const upsertMediaMessageStmt = db.prepare(`
  INSERT INTO media_messages (chat_jid, id, raw) VALUES (@chat_jid, @id, @raw)
  ON CONFLICT(chat_jid, id) DO UPDATE SET raw = excluded.raw
`);

export function upsertMediaMessage(chatJid: string, id: string, raw: Buffer) {
  upsertMediaMessageStmt.run({ chat_jid: chatJid, id, raw });
}

export function getMediaMessageRaw(chatJid: string, id: string): Buffer | undefined {
  const row = db.prepare(`SELECT raw FROM media_messages WHERE chat_jid = ? AND id = ?`).get(chatJid, id) as
    | { raw: Buffer }
    | undefined;
  return row?.raw;
}
