import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Alle rijen die er stonden voordat dit een meer-accounts-server werd, komen
// van het Claude-nummer. Te overschrijven als dat ooit anders ligt.
const LEGACY_ACCOUNT = process.env.WHATSAPP_MCP_LEGACY_ACCOUNT ?? "claude";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chats (
    account TEXT NOT NULL,
    jid TEXT NOT NULL,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_ts INTEGER,
    last_notified_ts INTEGER,
    PRIMARY KEY (account, jid)
  );

  CREATE TABLE IF NOT EXISTS messages (
    account TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    sender TEXT,
    text TEXT,
    type TEXT NOT NULL DEFAULT 'text',
    media_path TEXT,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (account, chat_jid, id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_account_ts ON messages (account, timestamp);

  CREATE TABLE IF NOT EXISTS contacts (
    account TEXT NOT NULL,
    jid TEXT NOT NULL,
    name TEXT,
    number TEXT,
    PRIMARY KEY (account, jid)
  );

  CREATE TABLE IF NOT EXISTS media_messages (
    account TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    raw BLOB NOT NULL,
    PRIMARY KEY (account, chat_jid, id)
  );
`;

function tableExists(table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function hasAccountColumn(table: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === "account");
}

/**
 * Zet een database van één account om naar meerdere. SQLite kan een primaire
 * sleutel niet wijzigen, dus elke tabel wordt opnieuw opgebouwd en gevuld.
 * Draait als één transactie: of alles gaat om, of er verandert niets.
 */
function migrateToMultiAccount() {
  const legacyTables = ["chats", "messages", "contacts", "media_messages"].filter(
    (t) => tableExists(t) && !hasAccountColumn(t)
  );
  if (legacyTables.length === 0) {
    db.exec(SCHEMA);
    return;
  }

  console.log(`Database-migratie: ${legacyTables.join(", ")} krijgen een account-kolom (bestaande rijen -> '${LEGACY_ACCOUNT}').`);
  const counts: Record<string, number> = {};
  for (const t of legacyTables) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }

  const run = db.transaction(() => {
    for (const t of legacyTables) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_pre_multi_account`);
    db.exec(`DROP INDEX IF EXISTS idx_messages_chat_ts`);
    db.exec(SCHEMA);

    if (legacyTables.includes("chats")) {
      db.exec(`INSERT INTO chats (account, jid, name, is_group, last_message_ts, last_notified_ts)
               SELECT '${LEGACY_ACCOUNT}', jid, name, is_group, last_message_ts, last_notified_ts
               FROM chats_pre_multi_account`);
    }
    if (legacyTables.includes("messages")) {
      db.exec(`INSERT INTO messages (account, chat_jid, id, from_me, sender, text, type, media_path, timestamp)
               SELECT '${LEGACY_ACCOUNT}', chat_jid, id, from_me, sender, text, type, media_path, timestamp
               FROM messages_pre_multi_account`);
    }
    if (legacyTables.includes("contacts")) {
      db.exec(`INSERT INTO contacts (account, jid, name, number)
               SELECT '${LEGACY_ACCOUNT}', jid, name, number FROM contacts_pre_multi_account`);
    }
    if (legacyTables.includes("media_messages")) {
      db.exec(`INSERT INTO media_messages (account, chat_jid, id, raw)
               SELECT '${LEGACY_ACCOUNT}', chat_jid, id, raw FROM media_messages_pre_multi_account`);
    }

    for (const t of legacyTables) {
      const before = counts[t];
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      if (after !== before) throw new Error(`Migratie van ${t}: ${before} rijen in, ${after} rijen uit. Afgebroken.`);
      db.exec(`DROP TABLE ${t}_pre_multi_account`);
      console.log(`  ${t}: ${after} rijen overgezet`);
    }
  });

  run();
  console.log("Database-migratie klaar.");
}

migrateToMultiAccount();

export interface ChatRow {
  account: string;
  jid: string;
  name: string | null;
  is_group: number;
  last_message_ts: number | null;
  last_notified_ts: number | null;
}

export interface MessageRow {
  account: string;
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
  account: string;
  jid: string;
  name: string | null;
  number: string | null;
}

/**
 * Bouwt de account-voorwaarde voor een leesquery. Zonder account wordt er over
 * alle accounts gekeken; de aanroeper zorgt dan zelf voor ontdubbeling.
 */
function accountClause(account: string | undefined, params: Record<string, unknown>, alias = ""): string[] {
  if (!account) return [];
  const col = alias ? `${alias}.account` : "account";
  params.account = account;
  return [`${col} = @account`];
}

function whereFrom(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

const upsertChatStmt = db.prepare(`
  INSERT INTO chats (account, jid, name, is_group, last_message_ts)
  VALUES (@account, @jid, @name, @is_group, @last_message_ts)
  ON CONFLICT(account, jid) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group,
    last_message_ts = MAX(COALESCE(excluded.last_message_ts, 0), COALESCE(chats.last_message_ts, 0))
`);

export function upsertChat(account: string, jid: string, name: string | null, isGroup: boolean, lastMessageTs: number | null) {
  upsertChatStmt.run({ account, jid, name, is_group: isGroup ? 1 : 0, last_message_ts: lastMessageTs });
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (account, jid, name, number)
  VALUES (@account, @jid, @name, @number)
  ON CONFLICT(account, jid) DO UPDATE SET
    name = COALESCE(excluded.name, contacts.name),
    number = COALESCE(excluded.number, contacts.number)
`);

export function upsertContact(account: string, jid: string, name: string | null, number: string | null) {
  upsertContactStmt.run({ account, jid, name, number });
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (account, chat_jid, id, from_me, sender, text, type, media_path, timestamp)
  VALUES (@account, @chat_jid, @id, @from_me, @sender, @text, @type, @media_path, @timestamp)
  ON CONFLICT(account, chat_jid, id) DO UPDATE SET
    text = COALESCE(excluded.text, messages.text),
    media_path = COALESCE(excluded.media_path, messages.media_path)
`);

export function insertMessage(msg: MessageRow) {
  insertMessageStmt.run(msg);
  upsertChatStmt.run({
    account: msg.account,
    jid: msg.chat_jid,
    name: null,
    is_group: msg.chat_jid.endsWith("@g.us") ? 1 : 0,
    last_message_ts: msg.timestamp,
  });
}

export function getChats(opts: { limit?: number; includeGroups?: boolean; account?: string } = {}): ChatRow[] {
  const limit = opts.limit ?? 20;
  const params: Record<string, unknown> = { limit };
  const clauses = accountClause(opts.account, params);
  if (opts.includeGroups === false) clauses.push("is_group = 0");
  // Zonder account-filter kan dezelfde chat op twee nummers staan (bv. een
  // groep waar beide in zitten); MIN(account) houdt er één over.
  const sql = opts.account
    ? `SELECT * FROM chats ${whereFrom(clauses)} ORDER BY last_message_ts DESC LIMIT @limit`
    : `SELECT MIN(account) AS account, jid, name, is_group,
              MAX(last_message_ts) AS last_message_ts, MAX(last_notified_ts) AS last_notified_ts
       FROM chats ${whereFrom(clauses)} GROUP BY jid ORDER BY last_message_ts DESC LIMIT @limit`;
  return db.prepare(sql).all(params) as ChatRow[];
}

export function getChat(jid: string, account?: string): ChatRow | undefined {
  const params: Record<string, unknown> = { jid };
  const clauses = ["jid = @jid", ...accountClause(account, params)];
  return db.prepare(`SELECT * FROM chats ${whereFrom(clauses)} LIMIT 1`).get(params) as ChatRow | undefined;
}

/** Accounts waarop deze chat bekend is. Leeg = nergens gezien. */
export function accountsForChat(jid: string): string[] {
  const rows = db.prepare(`SELECT DISTINCT account FROM chats WHERE jid = ?`).all(jid) as { account: string }[];
  return rows.map((r) => r.account);
}

export function getGroups(account?: string): ChatRow[] {
  const params: Record<string, unknown> = {};
  const clauses = ["is_group = 1", ...accountClause(account, params)];
  const sql = account
    ? `SELECT * FROM chats ${whereFrom(clauses)} ORDER BY last_message_ts DESC`
    : `SELECT MIN(account) AS account, jid, name, is_group,
              MAX(last_message_ts) AS last_message_ts, MAX(last_notified_ts) AS last_notified_ts
       FROM chats ${whereFrom(clauses)} GROUP BY jid ORDER BY last_message_ts DESC`;
  return db.prepare(sql).all(params) as ChatRow[];
}

export function searchChatsByName(query: string, isGroup?: boolean, account?: string): ChatRow[] {
  const params: Record<string, unknown> = { like: `%${query}%` };
  const clauses = ["name LIKE @like", ...accountClause(account, params)];
  if (isGroup !== undefined) {
    params.isGroup = isGroup ? 1 : 0;
    clauses.push("is_group = @isGroup");
  }
  const sql = account
    ? `SELECT * FROM chats ${whereFrom(clauses)} ORDER BY last_message_ts DESC LIMIT 20`
    : `SELECT MIN(account) AS account, jid, name, is_group,
              MAX(last_message_ts) AS last_message_ts, MAX(last_notified_ts) AS last_notified_ts
       FROM chats ${whereFrom(clauses)} GROUP BY jid ORDER BY last_message_ts DESC LIMIT 20`;
  return db.prepare(sql).all(params) as ChatRow[];
}

export function getMessages(opts: {
  chatJid?: string;
  query?: string;
  sender?: string;
  dateFrom?: number;
  dateTo?: number;
  isFromMe?: boolean;
  limit?: number;
  account?: string;
}): MessageRow[] {
  const params: Record<string, unknown> = {};
  const clauses = accountClause(opts.account, params);
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
  params.limit = opts.limit ?? 20;
  const where = whereFrom(clauses);
  // Een bericht in een gedeelde groep staat onder beide accounts; zonder
  // account-filter tellen we het één keer.
  const sql = opts.account
    ? `SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT @limit`
    : `SELECT MIN(account) AS account, chat_jid, id, from_me, sender, text, type, media_path, timestamp
       FROM messages ${where} GROUP BY chat_jid, id ORDER BY timestamp DESC LIMIT @limit`;
  return db.prepare(sql).all(params) as MessageRow[];
}

export function getMessageContext(chatJid: string, messageId: string, before = 5, after = 5, account?: string) {
  const anchorParams: Record<string, unknown> = { chatJid, messageId };
  const anchorClauses = ["chat_jid = @chatJid", "id = @messageId", ...accountClause(account, anchorParams)];
  const anchor = db.prepare(`SELECT * FROM messages ${whereFrom(anchorClauses)} LIMIT 1`).get(anchorParams) as
    | MessageRow
    | undefined;
  if (!anchor) return undefined;

  const side = (direction: "before" | "after", limit: number): MessageRow[] => {
    const params: Record<string, unknown> = { chatJid, ts: anchor.timestamp, limit, account: anchor.account };
    const cmp = direction === "before" ? "<" : ">";
    const order = direction === "before" ? "DESC" : "ASC";
    return db
      .prepare(
        `SELECT * FROM messages WHERE account = @account AND chat_jid = @chatJid AND timestamp ${cmp} @ts
         ORDER BY timestamp ${order} LIMIT @limit`
      )
      .all(params) as MessageRow[];
  };

  return { before: side("before", before).reverse(), message: anchor, after: side("after", after) };
}

export function getLastInteraction(chatJid: string, account?: string): MessageRow | undefined {
  const params: Record<string, unknown> = { chatJid };
  const clauses = ["chat_jid = @chatJid", ...accountClause(account, params)];
  return db.prepare(`SELECT * FROM messages ${whereFrom(clauses)} ORDER BY timestamp DESC LIMIT 1`).get(params) as
    | MessageRow
    | undefined;
}

export function getChatsForSender(jid: string, account?: string): ChatRow[] {
  const params: Record<string, unknown> = { jid };
  const clauses = [
    "(c.jid = @jid OR EXISTS (SELECT 1 FROM messages m WHERE m.account = c.account AND m.chat_jid = c.jid AND m.sender = @jid))",
    ...accountClause(account, params, "c"),
  ];
  return db
    .prepare(
      `SELECT MIN(c.account) AS account, c.jid, c.name, c.is_group,
              MAX(c.last_message_ts) AS last_message_ts, MAX(c.last_notified_ts) AS last_notified_ts
       FROM chats c ${whereFrom(clauses)} GROUP BY c.jid ORDER BY last_message_ts DESC`
    )
    .all(params) as ChatRow[];
}

export function searchContacts(query: string, account?: string): ContactRow[] {
  const params: Record<string, unknown> = { like: `%${query}%` };
  const clauses = ["(name LIKE @like OR number LIKE @like)", ...accountClause(account, params)];
  const sql = account
    ? `SELECT * FROM contacts ${whereFrom(clauses)} ORDER BY name LIMIT 20`
    : `SELECT MIN(account) AS account, jid, MIN(name) AS name, MIN(number) AS number
       FROM contacts ${whereFrom(clauses)} GROUP BY jid ORDER BY name LIMIT 20`;
  return db.prepare(sql).all(params) as ContactRow[];
}

export function getContact(jid: string, account?: string): ContactRow | undefined {
  const params: Record<string, unknown> = { jid };
  const clauses = ["jid = @jid", ...accountClause(account, params)];
  return db.prepare(`SELECT * FROM contacts ${whereFrom(clauses)} LIMIT 1`).get(params) as ContactRow | undefined;
}

/**
 * Best-effort weergavenaam voor een JID: contactnaam, dan chatnaam
 * (groepsonderwerp), anders het kale nummer. Met account kijkt hij eerst in
 * dat account en valt daarna terug op wat er elders bekend is.
 */
export function getDisplayName(jid: string, account?: string): string {
  if (account) {
    const scoped = getContact(jid, account)?.name ?? getChat(jid, account)?.name;
    if (scoped) return scoped;
  }
  const contact = getContact(jid);
  if (contact?.name) return contact.name;
  const chat = getChat(jid);
  if (chat?.name) return chat.name;
  return jid.split("@")[0];
}

// Nederlandse/Engelse vraagwoorden, om "gesprek is klaar"-berichten ("oke doei",
// "haha", "👍") eruit te filteren, zodat herinneringen alleen afgaan op iets dat
// op een open vraag lijkt.
const QUESTION_STARTERS = [
  "wat", "wanneer", "waar", "wie", "hoe", "waarom", "welke", "welk",
  "kun je", "kan je", "kunnen jullie", "kunnen we", "wil je", "willen jullie",
  "zou je", "zouden jullie", "heb je", "hebben jullie", "ga je", "gaan jullie",
  "mag ik", "mogen we", "is het", "is er", "zijn er", "weet je", "vind je",
  "denk je", "lukt het", "what", "when", "where", "who", "how", "why",
  "which", "can you", "could you", "would you", "do you", "did you",
  "are you", "is it", "have you", "will you", "should",
];

function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.length < 2) return false;
  if (t.includes("?")) return true;
  return QUESTION_STARTERS.some((w) => t === w || t.startsWith(`${w} `) || t.includes(` ${w} `));
}

export function getUnansweredChats(
  thresholdMinutes: number,
  maxAgeDays = 30,
  requireQuestion = true,
  account?: string
): ChatRow[] {
  const now = Date.now();
  const params: Record<string, unknown> = {
    cutoff: now - thresholdMinutes * 60_000,
    minTs: now - maxAgeDays * 24 * 60 * 60_000,
  };
  const clauses = [
    "c.is_group = 0",
    "c.last_message_ts IS NOT NULL",
    "c.last_message_ts <= @cutoff",
    "c.last_message_ts >= @minTs",
    ...accountClause(account, params, "c"),
  ];
  const candidates = db
    .prepare(
      `SELECT c.account, c.jid, c.name, c.is_group, c.last_message_ts, c.last_notified_ts, m.text AS last_text
       FROM chats c
       JOIN messages m ON m.account = c.account AND m.chat_jid = c.jid
                      AND m.timestamp = c.last_message_ts AND m.from_me = 0
       ${whereFrom(clauses)}
       ORDER BY c.last_message_ts ASC`
    )
    .all(params) as (ChatRow & { last_text: string | null })[];

  return candidates
    .filter((c) => !requireQuestion || looksLikeQuestion(c.last_text))
    .map(({ last_text, ...chat }) => chat);
}

export function markChatNotified(account: string, jid: string, ts: number) {
  db.prepare(`UPDATE chats SET last_notified_ts = ? WHERE account = ? AND jid = ?`).run(ts, account, jid);
}

const upsertMediaMessageStmt = db.prepare(`
  INSERT INTO media_messages (account, chat_jid, id, raw) VALUES (@account, @chat_jid, @id, @raw)
  ON CONFLICT(account, chat_jid, id) DO UPDATE SET raw = excluded.raw
`);

export function upsertMediaMessage(account: string, chatJid: string, id: string, raw: Buffer) {
  upsertMediaMessageStmt.run({ account, chat_jid: chatJid, id, raw });
}

export function getMediaMessageRaw(chatJid: string, id: string, account?: string): { raw: Buffer; account: string } | undefined {
  const params: Record<string, unknown> = { chatJid, id };
  const clauses = ["chat_jid = @chatJid", "id = @id", ...accountClause(account, params)];
  return db.prepare(`SELECT raw, account FROM media_messages ${whereFrom(clauses)} LIMIT 1`).get(params) as
    | { raw: Buffer; account: string }
    | undefined;
}
