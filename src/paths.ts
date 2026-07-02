import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const CONFIG_DIR = join(homedir(), ".whatsapp-mcp");
export const AUTH_DIR = join(CONFIG_DIR, "auth");
export const DATA_DIR = join(CONFIG_DIR, "data");
export const DOWNLOADS_DIR = join(CONFIG_DIR, "downloads");
export const DB_PATH = join(DATA_DIR, "whatsapp.db");

for (const dir of [AUTH_DIR, DATA_DIR, DOWNLOADS_DIR]) {
  mkdirSync(dir, { recursive: true });
}
