import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  findLumaEvents,
  resolveDateRange,
  resolveLumaCity,
  SUPPORTED_CITY_NAMES,
} from "@/lib/events/luma";

// Lists the city's upcoming events from Luma's discover API (the events behind
// luma.com/london and friends), with a short description and categories each,
// so the model can match them to the user's interest.
export default defineTool({
  description: `List upcoming events in a city from Luma. Supported cities: ${SUPPORTED_CITY_NAMES}. Fails with a "not supported" error for any other city. Covers the next 7 days unless you pass a date range. Returns each event's url, title, start time, time zone, availability, categories, and a short description. Use it to find events that match the user's interests.`,
  // A plain string rather than an enum, so an unsupported city reaches
  // execute and fails with a clear error instead of a schema validation error.
  inputSchema: z.object({
    city: z
      .string()
      .trim()
      .min(1)
      .describe(`The city the user is in, e.g. one of: ${SUPPORTED_CITY_NAMES}.`),
    from: z
      .string()
      .optional()
      .describe(
        "First day to include, as YYYY-MM-DD in the city's local time. Only set it when the user asks for specific dates.",
      ),
    to: z
      .string()
      .optional()
      .describe(
        "Last day to include (inclusive), as YYYY-MM-DD in the city's local time. Defaults to a week after `from`.",
      ),
  }),
  label: {
    start: ({ city }) => `Finding events in ${city}`,
  },
  async execute({ city, from, to }, ctx) {
    const lumaCity = resolveLumaCity(city);
    const range = from || to ? resolveDateRange(lumaCity, from, to) : null;
    return findLumaEvents(lumaCity, range, ctx.abortSignal);
  },
});
