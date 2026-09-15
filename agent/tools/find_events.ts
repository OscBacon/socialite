import { defineTool } from "eve/tools";
import { z } from "zod";
import { findLumaEvents, LUMA_CITY } from "@/lib/events/luma";

// Fetches luma.com/london, follows every event link on the page, and returns
// the details of each event so the model can match them to the user's interest.
export default defineTool({
  description: `List upcoming events in ${LUMA_CITY.name} from luma.com/${LUMA_CITY.slug}. Returns each event's url, title, start and end time, venue, categories, hosts, price, availability, guest count, and a short description. Use it to find events that match the user's interests.`,
  inputSchema: z.object({}),
  label: {
    start: () => `Finding events in ${LUMA_CITY.name}`,
  },
  async execute(_input, ctx) {
    const search = await findLumaEvents(ctx.abortSignal);
    // Cover images are only for display (show_events looks them up), so keep
    // the long image URLs out of the model's context.
    return { ...search, events: search.events.map(({ imageUrl: _imageUrl, ...event }) => event) };
  },
});
