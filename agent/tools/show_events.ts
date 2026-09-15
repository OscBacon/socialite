import { defineTool } from "eve/tools";
import { z } from "zod";

// Presentation tool: the chat UI renders its output as event cards with a
// link button each, so the model does not need to write the links itself.
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
  async execute({ events }) {
    return { events };
  },
});
