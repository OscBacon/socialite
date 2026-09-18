// Lists a city's upcoming events from Luma's discover API, which returns them
// sorted by start time in pages of up to 50, then looks up each event's
// description and categories in Luma's event API.
// Single event pages are still parsed from their HTML: each embeds schema.org
// JSON-LD (title, times, venue, description, offers) and Next.js page data
// (categories, hosts, ticket status), so no headless browser is needed.

const LUMA_ORIGIN = "https://luma.com";
const LUMA_API_ORIGIN = "https://api.luma.com";
const LUMA_HOSTS = new Set(["luma.com", "www.luma.com", "lu.ma", "www.lu.ma"]);
const USER_AGENT = "Mozilla/5.0 (compatible; Socialite/0.1)";
const FETCH_TIMEOUT_MS = 15_000;
// The discover API caps a page at 50 events.
const DISCOVER_PAGE_SIZE = 50;
const DISCOVER_MAX_PAGES = 6;
const DETAIL_CONCURRENCY = 8;
// Bounds the detail lookups and the tool output for wide date ranges.
const MAX_LISTED_EVENTS = 80;
const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LISTED_DESCRIPTION_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 500;
const LUMA_IMAGE_HOST = "images.lumacdn.com";
const THUMBNAIL_SIZE_PX = 320;

export const LUMA_CITIES = [
  {
    name: "London",
    slug: "london",
    placeId: "discplace-QCcNk3HXowOR97j",
    timeZone: "Europe/London",
  },
  { name: "Paris", slug: "paris", placeId: "discplace-NdLrh1xJfeotJZC", timeZone: "Europe/Paris" },
  {
    name: "New York",
    slug: "nyc",
    placeId: "discplace-Izx1rQVSh8njYpP",
    timeZone: "America/New_York",
  },
] as const;

export type LumaCity = (typeof LUMA_CITIES)[number];

export const SUPPORTED_CITY_NAMES = LUMA_CITIES.map((city) => city.name).join(", ");

// Matches a city by name or Luma slug, ignoring case, spaces, and punctuation,
// so "New York", "new-york", and "NYC" all resolve to luma.com/nyc.
export function resolveLumaCity(input: string): LumaCity {
  const key = normalizeCityKey(input);
  const city = LUMA_CITIES.find(
    (city) => normalizeCityKey(city.name) === key || city.slug === key,
  );

  if (!city) {
    throw new Error(`City "${input}" is not supported. Supported cities: ${SUPPORTED_CITY_NAMES}.`);
  }

  return city;
}

function normalizeCityKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type LumaEvent = {
  readonly url: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  // IANA time zone the event takes place in, e.g. "America/New_York".
  readonly timeZone: string;
  readonly venue: string | null;
  readonly categories: readonly string[];
  readonly hosts: readonly string[];
  readonly price: string | null;
  readonly availability: string;
  readonly guestCount: number | null;
  readonly description: string;
  readonly imageUrl: string | null;
};

// The lean shape `find_events` returns: enough to match an interest and to
// pass on to `show_events`.
export type LumaListedEvent = {
  readonly url: string;
  readonly title: string;
  readonly startsAt: string;
  // IANA time zone the event takes place in, e.g. "America/New_York".
  readonly timeZone: string;
  readonly availability: string;
  readonly categories: readonly string[];
  readonly description: string;
};

// Calendar days in the city's local time, both inclusive, as YYYY-MM-DD.
export type LumaDateRange = {
  readonly from: string;
  readonly to: string;
};

export type LumaEventSearch = {
  readonly city: string;
  readonly dateRange: string;
  readonly events: readonly LumaListedEvent[];
  readonly note?: string;
};

type DiscoverListing = Omit<LumaListedEvent, "categories" | "description"> & {
  readonly apiId: string;
  readonly endsAt: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Fills in a missing end of the range: `from` defaults to today in the city
// and `to` to a week after `from`.
export function resolveDateRange(
  city: LumaCity,
  from: string | undefined,
  to: string | undefined,
): LumaDateRange {
  for (const date of [from, to]) {
    if (date !== undefined && (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date)))) {
      throw new Error(`"${date}" is not a valid date. Use YYYY-MM-DD.`);
    }
  }

  const start = from ?? localDate(new Date().toISOString(), city.timeZone);
  const end =
    to ??
    new Date(Date.parse(start) + (DEFAULT_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);

  if (end < start) {
    throw new Error(`The date range ends (${end}) before it starts (${start}).`);
  }

  return { from: start, to: end };
}

// Without a date range, lists events starting within the next 7 days.
export async function findLumaEvents(
  city: LumaCity,
  range: LumaDateRange | null,
  signal?: AbortSignal,
): Promise<LumaEventSearch> {
  const now = new Date().toISOString();
  const windowEnd = new Date(Date.now() + DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  const isPastWindow = (event: DiscoverListing) =>
    range ? localDate(event.startsAt, event.timeZone) > range.to : event.startsAt >= windowEnd;
  const isInWindow = (event: DiscoverListing) =>
    // The listing still includes events that ended earlier today.
    (event.endsAt ?? event.startsAt) > now &&
    !isPastWindow(event) &&
    (!range || localDate(event.startsAt, event.timeZone) >= range.from);

  const listings = new Map<string, DiscoverListing>();
  let lastListed: DiscoverListing | null = null;
  let listingExhausted = false;
  let cursor: string | null = null;

  for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
    const url = new URL("/discover/get-paginated-events", LUMA_API_ORIGIN);
    url.searchParams.set("discover_place_api_id", city.placeId);
    url.searchParams.set("pagination_limit", String(DISCOVER_PAGE_SIZE));
    if (cursor) {
      url.searchParams.set("pagination_cursor", cursor);
    }

    const response = asRecord(await fetchJson(url.toString(), signal));
    const entries = Array.isArray(response?.entries) ? response.entries : [];

    for (const entry of entries) {
      const event = parseDiscoverEntry(asRecord(entry));
      if (!event) {
        continue;
      }
      lastListed = event;
      if (isInWindow(event) && !listings.has(event.url)) {
        listings.set(event.url, event);
      }
    }

    cursor = response?.has_more === true ? readString(response, "next_cursor") : null;
    if (!cursor) {
      listingExhausted = true;
      break;
    }
    // Events come sorted by start time, so later pages are all past the window.
    if (lastListed && isPastWindow(lastListed)) {
      break;
    }
  }

  const sorted = [...listings.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const kept = sorted.slice(0, MAX_LISTED_EVENTS);
  const events = await mapWithConcurrency(kept, DETAIL_CONCURRENCY, async (listing) => {
    const details = await fetchEventDetails(listing.apiId, signal).catch((error: unknown) => {
      if (signal?.aborted) {
        throw error;
      }
      return null;
    });
    const { apiId: _apiId, endsAt: _endsAt, ...event } = listing;
    return { ...event, categories: details?.categories ?? [], description: details?.description ?? "" };
  });

  let note: string | undefined;
  if (sorted.length > kept.length) {
    note = `Only the first ${kept.length} of ${sorted.length} events are listed. Use a narrower date range to see the rest.`;
  } else if (listingExhausted && lastListed && !isPastWindow(lastListed)) {
    note = `Luma only lists events up to ${localDate(lastListed.startsAt, lastListed.timeZone)} so far.`;
  }

  return {
    city: city.name,
    dateRange: range ? `${range.from} to ${range.to}` : `next ${DEFAULT_WINDOW_DAYS} days`,
    events,
    ...(note ? { note } : {}),
  };
}

function parseDiscoverEntry(entry: Record<string, unknown> | null): DiscoverListing | null {
  const event = asRecord(entry?.event);
  const apiId = readString(event, "api_id");
  const slug = readString(event, "url");
  const title = readString(event, "name");
  const startsAt = readString(event, "start_at");
  const timeZone = readString(event, "timezone");

  if (!entry || !apiId || !slug || !title || !startsAt || !timeZone) {
    return null;
  }

  return {
    apiId,
    url: `${LUMA_ORIGIN}/${slug}`,
    title,
    startsAt,
    endsAt: readString(event, "end_at"),
    timeZone,
    availability: formatDiscoverAvailability(entry, asRecord(entry.ticket_info)),
  };
}

async function fetchEventDetails(apiId: string, signal?: AbortSignal) {
  const url = new URL("/event/get", LUMA_API_ORIGIN);
  url.searchParams.set("event_api_id", apiId);
  const details = asRecord(await fetchJson(url.toString(), signal));

  return {
    categories: readNames(details?.categories),
    description: truncate(
      proseMirrorText(details?.description_mirror).replace(/\s+/g, " ").trim(),
      LISTED_DESCRIPTION_MAX_CHARS,
    ),
  };
}

// Flattens Luma's rich-text description (a ProseMirror document) to plain
// text, with a space between blocks so paragraphs don't run together.
function proseMirrorText(node: unknown): string {
  const record = asRecord(node);
  if (!record) {
    return "";
  }

  const children = Array.isArray(record.content) ? record.content : [];
  const text = (typeof record.text === "string" ? record.text : "") + children.map(proseMirrorText).join("");

  return record.type === "text" ? text : `${text} `;
}

// The calendar date an instant falls on in a time zone, as YYYY-MM-DD.
export function localDate(instant: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    }).format(new Date(instant));
  } catch {
    return instant.slice(0, 10);
  }
}

export function parseLumaEventPage(html: string, pageUrl: string): LumaEvent | null {
  const jsonLd = findJsonLdEvent(html);
  const title = readString(jsonLd, "name");
  const startsAt = readString(jsonLd, "startDate");
  const pageData = readNextPageData(html);
  const timeZone = readString(asRecord(pageData?.event), "timezone");

  if (!jsonLd || !title || !startsAt || !timeZone) {
    return null;
  }

  const ticketInfo = asRecord(pageData?.ticket_info);

  return {
    url: canonicalEventUrl(readString(jsonLd, "@id") ?? readString(jsonLd, "url") ?? pageUrl),
    title,
    startsAt,
    endsAt: readString(jsonLd, "endDate"),
    timeZone,
    venue: formatVenue(jsonLd.location),
    categories: readNames(pageData?.categories),
    hosts: pageData ? readNames(pageData.hosts) : readNames(jsonLd.organizer),
    price: formatPrice(jsonLd.offers, ticketInfo),
    availability: formatAvailability(jsonLd, pageData, ticketInfo),
    guestCount: typeof pageData?.guest_count === "number" ? pageData.guest_count : null,
    description: truncate(
      (readString(jsonLd, "description") ?? "").replace(/\s+/g, " ").trim(),
      DESCRIPTION_MAX_CHARS,
    ),
    imageUrl: readCoverImageUrl(jsonLd, pageData),
  };
}

export async function fetchLumaEvent(url: string, signal?: AbortSignal): Promise<LumaEvent | null> {
  const page = await fetchHtml(url, signal);
  return parseLumaEventPage(page.html, page.finalUrl);
}

// Rewrites a Luma-hosted image to a 320px square served by Luma's image CDN.
// Returns null for anything that is not a Luma image.
export function lumaThumbnailUrl(imageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== LUMA_IMAGE_HOST) {
    return null;
  }

  // Drop any existing transform, e.g. `/cdn-cgi/image/width=1920,.../uploads/...`.
  const path = url.pathname.replace(/^\/cdn-cgi\/image\/[^/]+/, "");
  const transform = `format=auto,fit=cover,dpr=1,anim=false,background=white,quality=75,width=${THUMBNAIL_SIZE_PX},height=${THUMBNAIL_SIZE_PX}`;

  return `https://${LUMA_IMAGE_HOST}/cdn-cgi/image/${transform}${path}`;
}

function readCoverImageUrl(
  jsonLd: Record<string, unknown>,
  pageData: Record<string, unknown> | null,
): string | null {
  const cover =
    readString(asRecord(pageData?.event), "cover_url") ??
    [jsonLd.image].flat().find((image): image is string => typeof image === "string");

  return cover ? lumaThumbnailUrl(cover) : null;
}

async function fetchHtml(url: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { accept: "text/html", "user-agent": USER_AGENT },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    throw new Error(`Luma returned HTTP ${response.status} for ${url}`);
  }

  return { finalUrl: response.url || url, html: await response.text() };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    throw new Error(`Luma returned HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

function findJsonLdEvent(html: string): Record<string, unknown> | null {
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const [, content] of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content!);
    } catch {
      continue;
    }

    const root = asRecord(parsed);
    const graph = root?.["@graph"];
    const candidates = Array.isArray(parsed) ? parsed : Array.isArray(graph) ? graph : [parsed];

    for (const candidate of candidates) {
      const record = asRecord(candidate);
      const types = [record?.["@type"]].flat();

      if (record && types.some((type) => typeof type === "string" && type.endsWith("Event"))) {
        return record;
      }
    }
  }

  return null;
}

function readNextPageData(html: string): Record<string, unknown> | null {
  const match = html.match(/<script\b[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);

  if (!match) {
    return null;
  }

  try {
    const nextData = asRecord(JSON.parse(match[1]!));
    const pageProps = asRecord(asRecord(nextData?.props)?.pageProps);
    return asRecord(asRecord(pageProps?.initialData)?.data);
  } catch {
    return null;
  }
}

function canonicalEventUrl(value: string): string {
  try {
    const url = new URL(value);
    return LUMA_HOSTS.has(url.hostname) ? `${LUMA_ORIGIN}${url.pathname}` : value;
  } catch {
    return value;
  }
}

function formatVenue(location: unknown): string | null {
  const place = asRecord([location].flat()[0]);

  if (!place) {
    return null;
  }

  if (place["@type"] === "VirtualLocation") {
    return "Online";
  }

  const address = asRecord(place.address);
  const parts: string[] = [];

  for (const part of [
    readString(place, "name"),
    readString(address, "streetAddress"),
    readString(address, "addressLocality"),
  ]) {
    if (part && !parts.join(", ").toLowerCase().includes(part.toLowerCase())) {
      parts.push(part);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatDiscoverAvailability(
  entry: Record<string, unknown>,
  ticketInfo: Record<string, unknown> | null,
): string {
  const registration = readString(entry, "registration_availability");

  if (registration === "waitlist" || (ticketInfo?.is_sold_out === true && entry.waitlist_active === true)) {
    return "Sold out (waitlist open)";
  }

  if (registration === "sold-out" || ticketInfo?.is_sold_out === true) {
    return "Sold out";
  }

  return formatAvailabilityNotes(ticketInfo);
}

function formatPrice(
  offers: unknown,
  ticketInfo: Record<string, unknown> | null,
): string | null {
  if (ticketInfo?.is_free === true) {
    return "Free";
  }

  const priced = [offers]
    .flat()
    .map(asRecord)
    .flatMap((offer) => {
      const price = Number(offer?.price);
      return offer && Number.isFinite(price)
        ? [{ currency: readString(offer, "priceCurrency"), price }]
        : [];
    });

  if (priced.length === 0) {
    return null;
  }

  const cheapest = priced.reduce((min, offer) => (offer.price < min.price ? offer : min));

  if (cheapest.price === 0) {
    return priced.length > 1 ? "Free options available" : "Free";
  }

  try {
    return new Intl.NumberFormat("en-GB", {
      currency: (cheapest.currency ?? "GBP").toUpperCase(),
      style: "currency",
    }).format(cheapest.price);
  } catch {
    return String(cheapest.price);
  }
}

function formatAvailability(
  jsonLd: Record<string, unknown>,
  pageData: Record<string, unknown> | null,
  ticketInfo: Record<string, unknown> | null,
): string {
  const eventStatus = readString(jsonLd, "eventStatus") ?? "";

  if (/Cancelled/i.test(eventStatus)) {
    return "Cancelled";
  }

  if (ticketInfo?.is_sold_out === true) {
    return pageData?.waitlist_active === true ? "Sold out (waitlist open)" : "Sold out";
  }

  return formatAvailabilityNotes(ticketInfo);
}

function formatAvailabilityNotes(ticketInfo: Record<string, unknown> | null): string {
  const notes: string[] = [];

  if (ticketInfo?.require_approval === true) {
    notes.push("Approval required");
  }

  if (ticketInfo?.is_near_capacity === true) {
    notes.push("Almost full");
  }

  return notes.length > 0 ? notes.join(", ") : "Open";
}

function readNames(value: unknown): string[] {
  return [value]
    .flat()
    .map((item) => readString(asRecord(item), "name"))
    .filter((name): name is string => Boolean(name));
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  // Don't cut an emoji in half: a lone surrogate makes Postgres reject the
  // JSON when the tool result is persisted.
  let end = maxLength - 1;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end).trimEnd()}…`;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
