// Shared parsing for `show_events` tool output, used by the web chat event
// cards and the Telegram channel's URL buttons.

export type ShownEvent = {
  readonly imageUrl: string | null;
  readonly reason: string;
  readonly startsAt: string | null;
  readonly title: string;
  readonly url: string;
};

const LUMA_EVENT_URL = /^https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^/?#\s]+$/;
const LUMA_IMAGE_URL = /^https:\/\/images\.lumacdn\.com\//;

const eventDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "Europe/London",
  weekday: "short",
});

export function parseShownEvents(output: unknown): ShownEvent[] | null {
  const events = asRecord(output)?.events;

  if (!Array.isArray(events)) {
    return null;
  }

  const shown = events.flatMap((value): ShownEvent[] => {
    const { imageUrl, reason, startsAt, title, url } = asRecord(value) ?? {};

    if (
      typeof url !== "string" ||
      !LUMA_EVENT_URL.test(url) ||
      typeof title !== "string" ||
      typeof reason !== "string"
    ) {
      return [];
    }

    return [
      {
        imageUrl: typeof imageUrl === "string" && LUMA_IMAGE_URL.test(imageUrl) ? imageUrl : null,
        reason,
        startsAt: typeof startsAt === "string" ? startsAt : null,
        title,
        url,
      },
    ];
  });

  return shown.length > 0 ? shown : null;
}

export function formatEventDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : eventDateFormatter.format(date);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
