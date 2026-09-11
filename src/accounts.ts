import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./paths.js";

export interface AccountConfig {
  /** Korte id, gebruikt in tool-parameters, mappen en de database. */
  id: string;
  /** Leesbare omschrijving voor logregels en tooluitvoer. */
  label: string;
  /** Het nummer dat hier hoort. Alleen ter controle na het koppelen. */
  number?: string;
  /** false = dit account verstuurt niets zonder expliciete ontgrendeling. */
  canSend: boolean;
  /** Meldingen over onbeantwoorde berichten voor dit account. */
  reminders: boolean;
}

// Standaard: het Claude-nummer mag verzenden, Davids eigen nummer niet.
// Zie ~/.codex/AGENTS.md, blok WhatsApp.
const DEFAULTS: AccountConfig[] = [
  { id: "claude", label: "Claude David", number: "31644598045", canSend: true, reminders: true },
  { id: "prive", label: "David privé", number: "31651290194", canSend: false, reminders: false },
];

const CONFIG_PATH = join(CONFIG_DIR, "accounts.json");

function loadAccounts(): AccountConfig[] {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return DEFAULTS; // geen configbestand: standaard twee accounts
  }
  try {
    const parsed = JSON.parse(raw) as AccountConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("leeg of geen lijst");
    for (const acc of parsed) {
      if (!acc.id || typeof acc.canSend !== "boolean") throw new Error(`onvolledig account: ${JSON.stringify(acc)}`);
    }
    return parsed;
  } catch (err) {
    // Een kapotte config mag niet stilletjes een verzendslot openzetten.
    throw new Error(`${CONFIG_PATH} is ongeldig: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ACCOUNTS: AccountConfig[] = loadAccounts();
export const ACCOUNT_IDS: string[] = ACCOUNTS.map((a) => a.id);

/** Account waar een verzendactie naartoe gaat als er geen is opgegeven. */
export const DEFAULT_SEND_ACCOUNT: string = (ACCOUNTS.find((a) => a.canSend) ?? ACCOUNTS[0]).id;

export function getAccount(id: string): AccountConfig {
  const found = ACCOUNTS.find((a) => a.id === id);
  if (!found) throw new Error(`Onbekend account '${id}'. Bekend: ${ACCOUNT_IDS.join(", ")}.`);
  return found;
}

export function accountLabel(id: string): string {
  const acc = ACCOUNTS.find((a) => a.id === id);
  return acc ? `${acc.id} (${acc.label})` : id;
}
