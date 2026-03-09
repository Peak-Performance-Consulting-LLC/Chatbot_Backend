import { getEnv } from "@/config/env";
import { logError } from "@/lib/logger";

type RawPlaceRecord = {
  type?: string | null;
  iata_code?: string | null;
  name?: string | null;
  city_name?: string | null;
  iata_country_code?: string | null;
  id?: string | null;
  city?: {
    name?: string | null;
  } | null;
  airports?: RawPlaceRecord[] | null;
};

export type PlaceSuggestion = {
  code: string;
  label: string;
  name: string;
  city: string;
  countryCode?: string;
  id?: string;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAirportCandidates(rawData: RawPlaceRecord[]): RawPlaceRecord[] {
  const list: RawPlaceRecord[] = [];

  for (const item of rawData) {
    if (Array.isArray(item.airports)) {
      list.push(...item.airports);
    }

    if ((item.type ?? "").toLowerCase() === "airport") {
      list.push(item);
    }
  }

  return list;
}

function scoreSuggestion(query: string, suggestion: PlaceSuggestion): number {
  const normalizedQuery = normalize(query);
  const code = suggestion.code.toLowerCase();
  const name = normalize(suggestion.name);
  const city = normalize(suggestion.city);

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedQuery === code) {
    return 120;
  }

  if (normalizedQuery === city) {
    return 110;
  }

  if (name.startsWith(normalizedQuery) || city.startsWith(normalizedQuery)) {
    return 100;
  }

  if (name.includes(normalizedQuery) || city.includes(normalizedQuery)) {
    return 90;
  }

  return 70;
}

function mapToSuggestions(query: string, records: RawPlaceRecord[]): PlaceSuggestion[] {
  const seen = new Set<string>();
  const suggestions: Array<PlaceSuggestion & { _score: number }> = [];

  for (const item of records) {
    const code = asString(item.iata_code)?.toUpperCase();
    if (!code || !/^[A-Z]{3}$/.test(code)) {
      continue;
    }

    if (seen.has(code)) {
      continue;
    }
    seen.add(code);

    const name = asString(item.name) ?? `${code} Airport`;
    const city = asString(item.city_name) ?? asString(item.city?.name) ?? code;
    const countryCode = asString(item.iata_country_code)?.toUpperCase();
    const id = asString(item.id);

    const suggestion: PlaceSuggestion = {
      code,
      name,
      city,
      countryCode,
      id,
      label: `${city} (${code}) - ${name}`
    };

    suggestions.push({
      ...suggestion,
      _score: scoreSuggestion(query, suggestion)
    });
  }

  return suggestions
    .sort((a, b) => b._score - a._score)
    .map(({ _score: _ignored, ...rest }) => rest);
}

export async function fetchPlaceSuggestions(query: string, limit = 8): Promise<PlaceSuggestion[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2) {
    return [];
  }

  const env = getEnv();
  const url = `${env.FLIGHT_PLACE_SUGGESTIONS_URL}?query=${encodeURIComponent(trimmedQuery)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = (await response.json().catch(() => ({}))) as {
      data?: RawPlaceRecord[];
    };

    const records = Array.isArray(json.data) ? json.data : [];
    const candidates = toAirportCandidates(records);
    const suggestions = mapToSuggestions(trimmedQuery, candidates);

    return suggestions.slice(0, Math.max(1, limit));
  } catch (error) {
    logError("flight_place_suggestions_failed", {
      query: trimmedQuery,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

export async function resolveAirportCodeFromPlaces(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    const requestedCode = trimmed.toUpperCase();
    const suggestions = await fetchPlaceSuggestions(requestedCode, 5);
    const exact = suggestions.find((item) => item.code === requestedCode);
    return exact?.code ?? null;
  }

  const suggestions = await fetchPlaceSuggestions(trimmed, 1);
  return suggestions[0]?.code ?? null;
}
