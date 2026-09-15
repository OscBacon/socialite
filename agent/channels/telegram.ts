import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";
import { formatEventDate, parseShownEvents } from "@/lib/events/shown-events";

// Comma-separated numeric Telegram user IDs. Fails closed: an empty or missing
// list drops every message.
const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

const BUTTON_TITLE_MAX_LENGTH = 40;

// Credentials come from TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN.
// Only private chats are supported, so the bot username (used for group
// mentions) is optional.
export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME || undefined,
  uploadPolicy: "disabled",
  async onMessage(ctx, message) {
    // Replaces eve's default dispatch gating: private chats from allowed,
    // non-bot users with text only. Everything else is dropped silently.
    const userId = message.from?.id;

    if (
      message.chat.type !== "private" ||
      !userId ||
      message.from?.isBot ||
      !allowedUserIds.has(userId) ||
      !message.text.trim()
    ) {
      return null;
    }

    await ctx.telegram.startTyping();
    return { auth: defaultTelegramAuth(message) };
  },
  events: {
    async "action.result"(data, channel) {
      const { result } = data;

      if (result.kind !== "tool-result" || result.toolName !== "show_events" || result.isError) {
        return;
      }

      const events = parseShownEvents(result.output);

      if (!events) {
        return;
      }

      const text = events
        .map((event) => {
          const date = event.startsAt ? ` (${formatEventDate(event.startsAt)})` : "";
          return `• ${event.title}${date} — ${event.reason}`;
        })
        .join("\n");

      await channel.telegram.post({
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: events.map((event) => [
            { text: `Open: ${truncate(event.title, BUTTON_TITLE_MAX_LENGTH)}`, url: event.url },
          ]),
        },
        text,
      });
    },
  },
});

function truncate(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
