import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";
import { formatEventDate, parseShownEvents } from "@/lib/events/shown-events";

const BUTTON_TITLE_MAX_LENGTH = 40;

// Credentials come from TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN.
// TELEGRAM_BOT_USERNAME is what lets the bot spot an `@mention` in a group, so
// set it wherever the bot is in group chats. Without it a group can still reach
// the agent by replying to one of its messages.
export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME || undefined,
  uploadPolicy: "disabled",
  async onMessage(ctx, message) {
    // Replaces eve's default dispatch gating, which also wakes on a bare
    // `/command`. socialite defines no commands, so a group reaches the agent
    // only by mentioning it or replying to it. Uploads are disabled, so a
    // message still has to carry text, and a message with no sender has no
    // identity to run as. Everything else is dropped silently.
    const auth = defaultTelegramAuth(message);

    if (!auth || !message.text.trim() || !isAddressedToAgent(ctx, message)) {
      return null;
    }

    await ctx.telegram.startTyping();
    return { auth };
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
          const date = event.startsAt ? ` (${formatEventDate(event.startsAt, event.timeZone)})` : "";
          return `• ${event.title}${date} — ${event.reason}`;
        })
        .join("\n");

      // Posts to the chat the session belongs to, so in a group the cards and
      // their buttons land in the group (and in its forum topic) rather than in
      // a private chat with whoever asked.
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

function isAddressedToAgent(ctx: TelegramContext, message: TelegramMessage) {
  if (message.chat.type === "private") {
    return true;
  }

  if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
    return false;
  }

  return mentionsAgent(message.text, ctx.telegram.botUsername) || repliesToAgent(ctx, message);
}

// Mirrors how eve decides `is_mentioned` in `<telegram_context>`: an exact
// `@name` token, or a command aimed at this bot such as `/events@name`. A name
// that merely appears inside a longer word does not count.
function mentionsAgent(text: string, botUsername: string | undefined) {
  if (!botUsername) {
    return false;
  }

  const name = botUsername.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  return (
    new RegExp(`(?:^|[^A-Za-z0-9_])@${name}(?=$|[^A-Za-z0-9_])`, "iu").test(text) ||
    new RegExp(`^/[A-Za-z0-9_]+@${name}(?:\\s|$)`, "iu").test(text)
  );
}

// A reply counts only when it answers this bot. Other bots in the group are not
// ours to answer, but Telegram can omit `username`, so an otherwise unidentified
// bot reply is accepted rather than dropped.
function repliesToAgent(ctx: TelegramContext, message: TelegramMessage) {
  const repliedTo = message.replyToMessage?.from;

  if (!repliedTo?.isBot) {
    return false;
  }

  const { botUsername } = ctx.telegram;

  return (
    !botUsername ||
    !repliedTo.username ||
    repliedTo.username.toLowerCase() === botUsername.toLowerCase()
  );
}

function truncate(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
