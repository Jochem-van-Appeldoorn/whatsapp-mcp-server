import notifier from "node-notifier";
import { getUnansweredChats, getDisplayName, markChatNotified } from "./db.js";

export function startReminders(thresholdMinutes = 30, intervalMs = 5 * 60_000): NodeJS.Timeout {
  const check = () => {
    const unanswered = getUnansweredChats(thresholdMinutes);
    for (const chat of unanswered) {
      if (chat.last_notified_ts && chat.last_message_ts && chat.last_notified_ts >= chat.last_message_ts) {
        continue; // already notified for this message
      }
      const displayName = getDisplayName(chat.jid);
      notifier.notify({
        title: "Onbeantwoord WhatsApp-bericht",
        message: `${displayName} wacht al meer dan ${thresholdMinutes} minuten op antwoord`,
        sound: true,
      });
      if (chat.last_message_ts) markChatNotified(chat.jid, chat.last_message_ts);
    }
  };

  check();
  return setInterval(check, intervalMs);
}
