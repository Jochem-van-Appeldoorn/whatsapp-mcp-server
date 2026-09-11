import notifier from "node-notifier";
import { getUnansweredChats, getDisplayName, markChatNotified } from "./db.js";
import { ACCOUNTS } from "./accounts.js";

/**
 * Meldingen over onbeantwoorde berichten, alleen voor accounts die daarom
 * vragen. Davids eigen nummer staat standaard uit: anders gaat zijn hele
 * privéverkeer hier piepen.
 */
export function startReminders(thresholdMinutes = 30, intervalMs = 5 * 60_000): NodeJS.Timeout | undefined {
  const accounts = ACCOUNTS.filter((a) => a.reminders);
  if (!accounts.length) return undefined;

  const check = () => {
    for (const account of accounts) {
      const unanswered = getUnansweredChats(thresholdMinutes, 30, true, account.id);
      for (const chat of unanswered) {
        if (chat.last_notified_ts && chat.last_message_ts && chat.last_notified_ts >= chat.last_message_ts) {
          continue; // already notified for this message
        }
        const displayName = getDisplayName(chat.jid, account.id);
        notifier.notify({
          title: "Onbeantwoord WhatsApp-bericht",
          message: `${displayName} wacht al meer dan ${thresholdMinutes} minuten op antwoord`,
          sound: true,
        });
        if (chat.last_message_ts) markChatNotified(account.id, chat.jid, chat.last_message_ts);
      }
    }
  };

  check();
  return setInterval(check, intervalMs);
}
