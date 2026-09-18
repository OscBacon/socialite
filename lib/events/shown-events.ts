// Shared parsing for `show_events` tool output, used by the web chat event
// cards and the Telegram channel's URL buttons.

export type ShownEvent = {
  readonly imageUrl: string | null;
  readonly reason: string;
  readonly startsAt: string | null;
  readonly timeZone: string | null;
  readonly title: string;
  readonly url: string;
};

const LUMA_EVENT_URL = /^https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^/?#\s]+$/;
const LUMA_IMAGE_URL = /^https:\/\/images\.lumacdn\.com\//;

// Events shown before show_events returned a time zone were all in London.
const DEFAULT_TIME_ZONE = "Europe/London";

export function parseShownEvents(output: unknown): ShownEvent[] | null {
  const events = asRecord(output)?.events;

  if (!Array.isArray(events)) {
    return null;
  }

  const shown = events.flatMap((value): ShownEvent[] => {
    const { imageUrl, reason, startsAt, timeZone, title, url } = asRecord(value) ?? {};

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
        timeZone: typeof timeZone === "string" ? timeZone : null,
        title,
        url,
      },
    ];
  });

  return shown.length > 0 ? shown : null;
}

// Formats the date in the event's own time zone, e.g. "Mon 21 Sept, 6:30 am".
export function formatEventDate(value: string, timeZone: string | null) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const options = {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    weekday: "short",
  } as const;

  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timeZone ?? DEFAULT_TIME_ZONE }).format(date);
  } catch {
    // Unknown time zone name.
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: DEFAULT_TIME_ZONE }).format(date);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
