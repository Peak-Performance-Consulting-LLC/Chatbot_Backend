import { getEnv } from "@/config/env";
import type { FlightDeal, FlightSearchState } from "@/flight/types";

const env = getEnv();

const CABIN_MAP: Record<string, "economy" | "premium_economy" | "business" | "first"> = {
  economy: "economy",
  premium_economy: "premium_economy",
  premiumeconomy: "premium_economy",
  business: "business",
  first: "first"
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return fallback;
}

type SerpPassenger = { type: "adult" } | { type: "child"; age?: number } | { type: "infant"; age?: number };

export type PlaceSuggestion = {
  code: string;
  name: string;
  city: string;
  label: string;
};

function toPassengerArray(
  adults: number,
  children: number,
  infants: number,
  childrenAges?: number[],
  infantsAges?: number[]
) {
  const passengers: SerpPassenger[] = [];

  for (let i = 0; i < Math.max(1, adults); i += 1) {
    passengers.push({ type: "adult" });
  }

  for (let i = 0; i < Math.max(0, children); i += 1) {
    const age = childrenAges?.[i];
    if (typeof age === "number" && age >= 0) {
      passengers.push({ type: "child", age });
    } else {
      passengers.push({ type: "child" });
    }
  }

  for (let i = 0; i < Math.max(0, infants); i += 1) {
    const age = infantsAges?.[i];
    if (typeof age === "number" && age >= 0) {
      passengers.push({ type: "infant", age });
    } else {
      passengers.push({ type: "infant" });
    }
  }

  return passengers;
}

/**
 * Sample payload validated against https://serp-api-olive.vercel.app/api/flights/search
 *
 * {
 *   "origin": "JFK",
 *   "destination": "LAX",
 *   "departure_date": "2026-03-15",
 *   "passengers": [{ "type": "adult" }],
 *   "cabin_class": "economy"
 * }
 */
export function buildSerpPayload(
  rawState: Partial<FlightSearchState> & Record<string, unknown>
): Record<string, unknown> {
  const origin = asString(rawState.origin ?? rawState.from ?? rawState.origin_code);
  const destination = asString(rawState.destination ?? rawState.to ?? rawState.destination_code);
  const departureDate = asString(rawState.depart_date ?? rawState.departureDate ?? rawState.departure_date);
  const returnDate = asString(rawState.return_date ?? rawState.returnDate);

  const adults = asNumber(
    rawState.passengers && typeof rawState.passengers === "object"
      ? (rawState.passengers as Record<string, unknown>).adults
      : rawState.adults,
    1
  );
  const children = asNumber(
    rawState.passengers && typeof rawState.passengers === "object"
      ? (rawState.passengers as Record<string, unknown>).children
      : rawState.children,
    0
  );
  const infants = asNumber(
    rawState.passengers && typeof rawState.passengers === "object"
      ? (rawState.passengers as Record<string, unknown>).infants
      : rawState.infants,
    0
  );
  const childrenAges = Array.isArray((rawState.passengers as { children_ages?: unknown } | undefined)?.children_ages)
    ? ((rawState.passengers as { children_ages?: unknown[] }).children_ages ?? [])
        .map((value) => asNumber(value, -1))
        .filter((value) => value >= 0)
    : [];
  const infantsAges = Array.isArray((rawState.passengers as { infants_ages?: unknown } | undefined)?.infants_ages)
    ? ((rawState.passengers as { infants_ages?: unknown[] }).infants_ages ?? [])
        .map((value) => asNumber(value, -1))
        .filter((value) => value >= 0)
    : [];

  const rawCabin = asString(rawState.cabin_class ?? rawState.cabinClass)?.toLowerCase() ?? "economy";
  const cabinClass = CABIN_MAP[rawCabin] ?? "economy";
  const currency = asString(rawState.currency ?? rawState.currency_code)?.toUpperCase() ?? "USD";

  const payload: Record<string, unknown> = {
    origin,
    destination,
    departure_date: departureDate,
    passengers: toPassengerArray(adults, children, infants, childrenAges, infantsAges),
    cabin_class: cabinClass,
    currency
  };

  if (returnDate) {
    payload.return_date = returnDate;
  }

  return payload;
}

function parsePriceValue(price: string): number {
  const numeric = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isNaN(numeric) ? Number.MAX_SAFE_INTEGER : numeric;
}

function parseStops(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.stops === "number" && Number.isFinite(raw.stops)) {
    return Math.max(0, Math.floor(raw.stops));
  }

  if (typeof raw.stop_count === "number" && Number.isFinite(raw.stop_count)) {
    return Math.max(0, Math.floor(raw.stop_count));
  }

  return undefined;
}

function mapFlight(raw: Record<string, unknown>): FlightDeal {
  const airline = raw.airline as Record<string, unknown> | undefined;

  return {
    id: String(raw.id ?? crypto.randomUUID()),
    total_price: String(raw.total_price ?? raw.total_amount ?? "N/A"),
    total_amount: asString(raw.total_amount),
    total_currency: asString(raw.total_currency),
    airline: String(airline?.name ?? raw.airline ?? "Unknown Airline"),
    airline_logo: asString(airline?.logo),
    departure_time: String((raw.departure as Record<string, unknown> | undefined)?.time ?? ""),
    arrival_time: String((raw.arrival as Record<string, unknown> | undefined)?.time ?? ""),
    origin: String((raw.departure as Record<string, unknown> | undefined)?.iata_code ?? ""),
    destination: String((raw.arrival as Record<string, unknown> | undefined)?.iata_code ?? ""),
    stops: parseStops(raw),
    duration: String(raw.duration ?? ""),
    cabin_class: String(raw.cabin_class ?? ""),
    raw
  };
}

export async function searchFlightsByPayload(payload: Record<string, unknown>): Promise<{
  deals: FlightDeal[];
  rawResponse: Record<string, unknown>;
}> {
  const response = await fetch(env.FLIGHT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const errMessage =
      typeof json.error === "string"
        ? json.error
        : `Flight search failed with status ${response.status}`;
    throw new Error(errMessage);
  }

  const rawFlights = Array.isArray(json.flights)
    ? (json.flights as Record<string, unknown>[])
    : Array.isArray((json.data as Record<string, unknown> | undefined)?.flights)
      ? (((json.data as Record<string, unknown>).flights as Record<string, unknown>[]) ?? [])
      : [];

  return {
    deals: rawFlights
      .map((item) => mapFlight(item))
      .sort((a, b) => parsePriceValue(a.total_price) - parsePriceValue(b.total_price)),
    rawResponse: json
  };
}

function getPlaceSuggestionsUrl(query: string): string {
  const source = new URL(env.FLIGHT_SEARCH_URL);
  source.pathname = "/api/flights/place-suggestions";
  source.search = "";
  source.searchParams.set("query", query);
  return source.toString();
}

function toPlaceSuggestions(raw: unknown): PlaceSuggestion[] {
  const seen = new Set<string>();
  const suggestions: PlaceSuggestion[] = [];

  function addItem(item: Record<string, unknown>) {
    const code = asString(item.iata_code)?.toUpperCase() ?? "";
    if (!/^[A-Z]{3}$/.test(code)) {
      return;
    }

    const name = asString(item.name) ?? code;
    const city =
      asString(item.city_name) ??
      (typeof item.city === "object" && item.city ? asString((item.city as Record<string, unknown>).name) ?? "" : "");
    const dedupe = `${code}:${name}`;
    if (seen.has(dedupe)) {
      return;
    }

    seen.add(dedupe);
    suggestions.push({
      code,
      name,
      city,
      label: city ? `${code} - ${name} (${city})` : `${code} - ${name}`
    });
  }

  if (!raw || typeof raw !== "object") {
    return suggestions;
  }

  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return suggestions;
  }

  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const item = entry as Record<string, unknown>;
    if (Array.isArray(item.airports)) {
      for (const airport of item.airports) {
        if (airport && typeof airport === "object") {
          addItem(airport as Record<string, unknown>);
        }
      }
    }

    if (item.type === "airport") {
      addItem(item);
    }
  }

  return suggestions.slice(0, 8);
}

export async function suggestAirports(query: string): Promise<PlaceSuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 2) {
    return [];
  }

  try {
    const response = await fetch(getPlaceSuggestionsUrl(normalized), {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    const json = (await response.json().catch(() => ({ data: [] }))) as unknown;
    if (!response.ok) {
      return [];
    }

    return toPlaceSuggestions(json);
  } catch {
    return [];
  }
}

export async function searchFlights(state: FlightSearchState): Promise<{
  payload: Record<string, unknown>;
  deals: FlightDeal[];
  rawResponse: Record<string, unknown>;
}> {
  const payload = buildSerpPayload(state as Partial<FlightSearchState> & Record<string, unknown>);
  const result = await searchFlightsByPayload(payload);
  return {
    payload,
    deals: result.deals,
    rawResponse: result.rawResponse
  };
}
