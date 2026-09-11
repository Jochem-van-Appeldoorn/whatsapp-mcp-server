import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const CONFIG_DIR = join(homedir(), ".whatsapp-mcp");
export const ACCOUNTS_DIR = join(CONFIG_DIR, "accounts");
export const DATA_DIR = join(CONFIG_DIR, "data");
export const DOWNLOADS_DIR = join(CONFIG_DIR, "downloads");
export const DB_PATH = join(DATA_DIR, "whatsapp.db");

for (const dir of [ACCOUNTS_DIR, DATA_DIR, DOWNLOADS_DIR]) {
  mkdirSync(dir, { recursive: true });
}

/** Auth-map van één account. Elk account is een eigen gekoppeld apparaat. */
export function authDir(accountId: string): string {
  const dir = join(ACCOUNTS_DIR, accountId, "auth");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Map waar de QR-code van dit account wordt weggeschreven tijdens koppelen. */
export function qrPath(accountId: string): string {
  return join(ACCOUNTS_DIR, accountId, "qr.txt");
}

/** Downloads per account gescheiden, zodat bericht-ids elkaar niet overschrijven. */
export function downloadsDir(accountId: string): string {
  const dir = join(DOWNLOADS_DIR, accountId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
