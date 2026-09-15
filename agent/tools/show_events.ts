import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchLumaEvent } from "@/lib/events/luma";

// Presentation tool: the chat UI renders its output as event cards with a
// cover image and a link button each, so the model does not need to write the
// links itself.
const LUMA_EVENT_URL = /^https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^/?#\s]+$/;
const REASON_WORD_COUNT = 5;

export default defineTool({
  description:
    "Show the user up to three recommended events as cards with a clickable link button. Use only events returned by find_events.",
  inputSchema: z.object({
    events: z
      .array(
        z.object({
          url: z
            .string()
            .regex(LUMA_EVENT_URL, "url must be a luma.com event URL returned by find_events"),
          title: z.string().trim().min(1),
          startsAt: z.string().optional().describe("The event's startsAt value from find_events."),
          reason: z
            .string()
            .trim()
            .refine(
              (reason) => reason.split(/\s+/).length === REASON_WORD_COUNT,
              `reason must be exactly ${REASON_WORD_COUNT} words`,
            )
            .describe(
              `Exactly ${REASON_WORD_COUNT} words on why this event matches the user's interest.`,
            ),
        }),
      )
      .min(1)
      .max(3),
  }),
  label: {
    start: ({ events }) => `Showing ${events.length} event${events.length === 1 ? "" : "s"}`,
  },
  async execute({ events }, ctx) {
    // Look up each event page for its cover image, and its canonical URL,
    // title, and time, rather than trusting the model to copy long URLs.
    // A failed lookup still shows the card, just without an image.
    const shown = await Promise.all(
      events.map(async (event) => {
        const details = await fetchLumaEvent(event.url, ctx.abortSignal).catch((error: unknown) => {
          if (ctx.abortSignal?.aborted) {
            throw error;
          }
          return null;
        });

        return {
          url: details?.url ?? event.url,
          title: details?.title ?? event.title,
          startsAt: details?.startsAt ?? event.startsAt ?? null,
          reason: event.reason,
          imageUrl: details?.imageUrl ?? null,
        };
      }),
    );

    return { events: shown };
  },
});
