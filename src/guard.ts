import { randomUUID } from "node:crypto";
import notifier from "node-notifier";
import { getAccount, accountLabel } from "./accounts.js";

/**
 * Verzendslot voor accounts met canSend: false.
 *
 * Davids eigen nummer mag niets versturen. Er is één uitweg en die is smal:
 * David geeft in het gesprek toestemming, waarna er een ontgrendeling komt die
 * aan precies één ontvanger en één berichttekst vastzit, drie minuten geldig is
 * en na gebruik vervalt. Elke ontgrendeling geeft een melding op het scherm en
 * een regel in het log, zodat David ziet wat er gebeurt ook als hij er niet om
 * gevraagd heeft.
 */

const UNLOCK_TTL_MS = 3 * 60_000;

export type SendKind = "text" | "file" | "audio";

interface Unlock {
  token: string;
  account: string;
  jid: string;
  kind: SendKind;
  subject: string;
  confirmation: string;
  createdAt: number;
  usedAt?: number;
}

const unlocks = new Map<string, Unlock>();

function log(message: string) {
  console.log(`${new Date().toISOString()} [verzendslot] ${message}`);
}

function prune() {
  const now = Date.now();
  for (const [token, u] of unlocks) {
    if (u.usedAt || now - u.createdAt > UNLOCK_TTL_MS) unlocks.delete(token);
  }
}

/** Normaliseert de tekst waarop een ontgrendeling vastzit, zodat witruimte niet telt. */
function normalize(subject: string): string {
  return subject.replace(/\s+/g, " ").trim();
}

export function mayAccountSend(accountId: string): boolean {
  return getAccount(accountId).canSend;
}

export function createUnlock(opts: {
  account: string;
  jid: string;
  kind: SendKind;
  subject: string;
  confirmation: string;
  targetLabel: string;
}): Unlock {
  const account = getAccount(opts.account);
  if (account.canSend) {
    throw new Error(`Account '${account.id}' mag sowieso al verzenden; een ontgrendeling is hier niet nodig.`);
  }
  prune();

  const unlock: Unlock = {
    token: randomUUID(),
    account: account.id,
    jid: opts.jid,
    kind: opts.kind,
    subject: normalize(opts.subject),
    confirmation: opts.confirmation,
    createdAt: Date.now(),
  };
  unlocks.set(unlock.token, unlock);

  log(
    `ONTGRENDELD ${accountLabel(account.id)} -> ${opts.targetLabel} (${opts.kind}); ` +
      `toestemming volgens Claude: "${opts.confirmation}"; inhoud: "${unlock.subject.slice(0, 200)}"`
  );
  notifier.notify({
    title: `Verzenden vanaf ${account.label} ontgrendeld`,
    message: `Naar ${opts.targetLabel}\n${unlock.subject.slice(0, 120)}`,
    sound: true,
  });

  return unlock;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Poortwachter voor elke verzendactie. Accounts die mogen verzenden komen er
 * zonder meer door; de rest heeft een geldige, passende ontgrendeling nodig.
 */
export function checkSendAllowed(opts: {
  account: string;
  jid: string;
  kind: SendKind;
  subject: string;
  token?: string;
}): GuardResult {
  const account = getAccount(opts.account);
  if (account.canSend) return { ok: true };

  if (!opts.token) {
    return {
      ok: false,
      reason:
        `Verzenden vanaf '${account.id}' (${account.label}) is geblokkeerd. Dit is Davids eigen nummer; ` +
        `berichten komen daar binnen alsof David ze zelf stuurt. Vraag het David letterlijk, en gebruik pas ` +
        `daarna unlock_prive_send met zijn eigen woorden als bevestiging. Zonder toestemming: gebruik account ` +
        `'claude' of leg het bericht aan David voor zodat hij het zelf verstuurt.`,
    };
  }

  prune();
  const unlock = unlocks.get(opts.token);
  if (!unlock) return { ok: false, reason: "Ontgrendeling onbekend of verlopen (geldig: 3 minuten, eenmalig)." };
  if (unlock.usedAt) return { ok: false, reason: "Deze ontgrendeling is al gebruikt. Eén ontgrendeling geldt voor één bericht." };
  if (Date.now() - unlock.createdAt > UNLOCK_TTL_MS) {
    unlocks.delete(opts.token);
    return { ok: false, reason: "Ontgrendeling is verlopen (geldig: 3 minuten)." };
  }
  if (unlock.account !== account.id) {
    return { ok: false, reason: `Ontgrendeling hoort bij account '${unlock.account}', niet bij '${account.id}'.` };
  }
  if (unlock.jid !== opts.jid) {
    return { ok: false, reason: `Ontgrendeling is afgegeven voor een andere ontvanger (${unlock.jid}).` };
  }
  if (unlock.kind !== opts.kind) {
    return { ok: false, reason: `Ontgrendeling is afgegeven voor '${unlock.kind}', niet voor '${opts.kind}'.` };
  }
  if (unlock.subject !== normalize(opts.subject)) {
    return {
      ok: false,
      reason:
        "De inhoud wijkt af van wat er is ontgrendeld. Tekst gewijzigd? Vraag David opnieuw en maak een nieuwe ontgrendeling.",
    };
  }

  unlock.usedAt = Date.now();
  unlocks.delete(unlock.token);
  log(`GEBRUIKT ${accountLabel(account.id)} -> ${unlock.jid} (${unlock.kind})`);
  return { ok: true };
}
