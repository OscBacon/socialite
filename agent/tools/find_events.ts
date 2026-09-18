import { defineTool } from "eve/tools";
import { z } from "zod";
import { findLumaEvents, resolveLumaCity, SUPPORTED_CITY_NAMES } from "@/lib/events/luma";

// Fetches the city's Luma page (e.g. luma.com/london), follows every event link
// on it, and returns the details of each event so the model can match them to
// the user's interest.
export default defineTool({
  description: `List upcoming events in a city from its Luma page. Supported cities: ${SUPPORTED_CITY_NAMES}. Fails with a "not supported" error for any other city. Returns each event's url, title, start and end time, time zone, venue, categories, hosts, price, availability, guest count, and a short description. Use it to find events that match the user's interests.`,
  // A plain string rather than an enum, so an unsupported city reaches
  // execute and fails with a clear error instead of a schema validation error.
  inputSchema: z.object({
    city: z
      .string()
      .trim()
      .min(1)
      .describe(`The city the user is in, e.g. one of: ${SUPPORTED_CITY_NAMES}.`),
  }),
  label: {
    start: ({ city }) => `Finding events in ${city}`,
  },
  async execute({ city }, ctx) {
    const search = await findLumaEvents(resolveLumaCity(city), ctx.abortSignal);
    // Cover images are only for display (show_events looks them up), so keep
    // the long image URLs out of the model's context.
    return { ...search, events: search.events.map(({ imageUrl: _imageUrl, ...event }) => event) };
  },
});
