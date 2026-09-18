// Fetches upcoming events from a Luma city page with plain HTTP requests.
// The city page lists event links; each event page embeds schema.org JSON-LD
// (title, times, venue, description, offers) and Next.js page data
// (categories, hosts, ticket status), so no headless browser is needed.

const LUMA_ORIGIN = "https://luma.com";
const LUMA_HOSTS = new Set(["luma.com", "www.luma.com", "lu.ma", "www.lu.ma"]);
const USER_AGENT = "Mozilla/5.0 (compatible; Socialite/0.1)";
const FETCH_TIMEOUT_MS = 15_000;
const DETAIL_CONCURRENCY = 5;
const DESCRIPTION_MAX_CHARS = 500;
const LUMA_IMAGE_HOST = "images.lumacdn.com";
const THUMBNAIL_SIZE_PX = 320;

export const LUMA_CITIES = [
  { name: "London", slug: "london" },
  { name: "Paris", slug: "paris" },
  { name: "New York", slug: "nyc" },
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

// Single-segment Luma paths that are product or city pages rather than events.
const NON_EVENT_SLUGS = new Set([
  ...LUMA_CITIES.map((city) => city.slug),
  "app",
  "create",
  "discover",
  "explore",
  "help",
  "home",
  "map",
  "pricing",
  "signin",
  "signup",
]);

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

export type LumaEventSearch = {
  readonly city: string;
  readonly sourceUrl: string;
  readonly linkCount: number;
  readonly events: readonly LumaEvent[];
  readonly skippedUrls: readonly string[];
};

export async function findLumaEvents(
  city: LumaCity,
  signal?: AbortSignal,
): Promise<LumaEventSearch> {
  const sourceUrl = `${LUMA_ORIGIN}/${city.slug}`;
  const page = await fetchHtml(sourceUrl, signal);
  const links = extractEventLinks(page.html, page.finalUrl);

  const results = await mapWithConcurrency(links, DETAIL_CONCURRENCY, async (url) => {
    try {
      return { event: await fetchLumaEvent(url, signal), url };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return { event: null, url };
    }
  });

  const events = new Map<string, LumaEvent>();
  const skippedUrls: string[] = [];

  for (const { event, url } of results) {
    if (!event) {
      skippedUrls.push(url);
    } else if (!events.has(event.url)) {
      // Redirecting slugs resolve to the same canonical event URL.
      events.set(event.url, event);
    }
  }

  return {
    city: city.name,
    sourceUrl,
    linkCount: links.length,
    events: [...events.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    skippedUrls,
  };
}

export function extractEventLinks(html: string, pageUrl: string): string[] {
  const links = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!.replace(/&amp;/g, "&");

    if (/signin/i.test(href)) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }

    // `?k=c` marks calendar (organizer) links rather than events.
    if (!LUMA_HOSTS.has(url.hostname) || url.searchParams.get("k") === "c") {
      continue;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const slug = segments[0];

    if (segments.length !== 1 || !slug) {
      continue;
    }

    if (NON_EVENT_SLUGS.has(slug.toLowerCase())) {
      continue;
    }

    links.add(`${LUMA_ORIGIN}/${slug}`);
  }

  return [...links];
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
