import { defineDynamic, defineInstructions } from "eve/instructions";
import { LUMA_CITIES } from "@/lib/events/luma";

// The model has no clock, so tell it today's date in each supported city to
// resolve requests like "this weekend" or "next week" into find_events dates.
export default defineDynamic({
  events: {
    "turn.started": () => {
      const now = new Date();
      const days = LUMA_CITIES.map(
        (city) =>
          `${now.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            timeZone: city.timeZone,
            weekday: "long",
            year: "numeric",
          })} in ${city.name}`,
      );

      return defineInstructions({ content: `Today is ${days.join(", ")}.` });
    },
  },
});
