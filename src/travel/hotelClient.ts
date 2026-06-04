import { getEnv } from "@/config/env";
import { logError } from "@/lib/logger";
import type { TravelServiceState } from "@/travel/types";

export type HotelSearchResult = {
  id: string;
  name: string;
  destination: string;
  area: string;
  nightly_price: string;
  rating: string;
  highlights: string[];
  image_url?: string;
  description?: string;
  amenities?: string[];
  property_token?: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePrice(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  return text.toLowerCase().includes("night") ? text : `${text}/night`;
}

function getArea(raw: Record<string, unknown>, destination: string): string {
  return (
    asString(raw.neighborhood) ??
    asString(raw.area) ??
    asString(raw.location) ??
    asString(raw.address) ??
    destination
  );
}

function buildHighlights(raw: Record<string, unknown>): string[] {
  const highlights = new Set<string>();
  const rating = asNumber(raw.rating);
  const reviews = asNumber(raw.reviews);

  if (rating !== null && rating >= 4.5) highlights.add("Top rated");
  if (rating !== null && rating >= 4) highlights.add("Guest favorite");
  if (reviews !== null && reviews > 500) highlights.add(`${Math.round(reviews).toLocaleString("en-US")} reviews`);
  highlights.add("Live hotel result");

  return Array.from(highlights).slice(0, 3);
}

function mapHotel(raw: Record<string, unknown>, destination: string, index: number): HotelSearchResult | null {
  const name = asString(raw.name);
  if (!name) return null;

  const propertyToken = asString(raw.property_token);
  const price = normalizePrice(raw.price) ?? "Price unavailable";
  const rating = asNumber(raw.rating);
  const reviews = asNumber(raw.reviews);
  const area = getArea(raw, destination);
  const imageUrl = asString(raw.thumbnail) ?? asString(raw.image) ?? asString(raw.image_url);

  return {
    id: propertyToken ?? `hotel-api-${index}`,
    name,
    destination,
    area,
    nightly_price: price,
    rating: rating !== null ? rating.toFixed(1).replace(/\.0$/, "") : "No rating",
    highlights: buildHighlights(raw),
    image_url: imageUrl ?? undefined,
    description: [
      `${name} is a live hotel result for ${destination}.`,
      reviews !== null ? `It has ${Math.round(reviews).toLocaleString("en-US")} guest reviews.` : ""
    ].filter(Boolean).join(" "),
    amenities: buildHighlights(raw),
    property_token: propertyToken ?? undefined
  };
}

export async function searchHotelDeals(state: TravelServiceState): Promise<HotelSearchResult[]> {
  const destination = asString(state.slots.destination) ?? "your destination";
  const checkInDate = asString(state.slots.check_in_date);
  const checkOutDate = asString(state.slots.check_out_date);
  if (!checkInDate || !checkOutDate) return [];

  const url = new URL(getEnv().HOTEL_SEARCH_URL);
  url.searchParams.set("q", destination);
  url.searchParams.set("check_in_date", checkInDate);
  url.searchParams.set("check_out_date", checkOutDate);
  url.searchParams.set("adults", String(Math.max(1, Number(state.slots.guests ?? 1))));
  url.searchParams.set("rooms", String(Math.max(1, Number(state.slots.rooms ?? 1))));

  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Hotel search failed with ${response.status}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const rawHotels = Array.isArray(json.hotels)
      ? json.hotels
      : Array.isArray((json.data as Record<string, unknown> | undefined)?.hotels)
        ? ((json.data as Record<string, unknown>).hotels as unknown[])
        : [];

    return rawHotels
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item, index) => mapHotel(item, destination, index))
      .filter((item): item is HotelSearchResult => Boolean(item))
      .slice(0, 3);
  } catch (error) {
    logError("hotel_search_failed", {
      error: error instanceof Error ? error.message : String(error),
      destination,
      check_in_date: checkInDate,
      check_out_date: checkOutDate
    });
    return [];
  }
}
