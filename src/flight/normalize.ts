import type { CabinClass, PassengerCounts, TripType } from "@/flight/types";
import { bestFuzzyMatch } from "@/flight/fuzzy";

const genericAirportWords = new Set(["airport", "city", "town", "place", "there", "here"]);
const airportIntentKeywords = [
  "flight",
  "flights",
  "deal",
  "deals",
  "cheap",
  "book",
  "booking",
  "need",
  "want",
  "find",
  "search",
  "ticket",
  "help",
  "please",
  "hello",
  "hi"
];

function cleanAirportInput(input: string): string {
  return input
    .replace(/^(from|to)\s+/i, "")
    .replace(/^(origin|destination)\s*[:=-]\s*/i, "")
    .replace(/[.,!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNonLocationInput(input: string): boolean {
  const text = input.toLowerCase();
  return airportIntentKeywords.some((keyword) => text.includes(keyword));
}

function looksLikeGibberish(input: string): boolean {
  const text = input.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (!text) {
    return true;
  }

  const letters = text.replace(/\s+/g, "");
  if (letters.length < 3) {
    return true;
  }

  if (/(.)\1{3,}/.test(letters)) {
    return true;
  }

  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  if (letters.length >= 6 && vowels === 0) {
    return true;
  }

  return false;
}

export function extractIataCode(input: string): string | null {
  const cleaned = cleanAirportInput(input);
  return /^[A-Za-z]{3}$/.test(cleaned) ? cleaned.toUpperCase() : null;
}

export function normalizeAirportInput(input: string): {
  value?: string;
  ambiguous: boolean;
  clarificationQuestion?: string;
} {
  const cleaned = cleanAirportInput(input);
  const words = cleaned.split(" ").filter(Boolean);

  if (
    !cleaned ||
    cleaned.length < 3 ||
    genericAirportWords.has(cleaned.toLowerCase()) ||
    words.length > 4 ||
    looksLikeNonLocationInput(cleaned) ||
    looksLikeGibberish(cleaned)
  ) {
    return {
      ambiguous: true,
      clarificationQuestion: "Please share a clear city or airport (example: JFK or New York)."
    };
  }

  const iata = extractIataCode(cleaned);
  if (iata) {
    return { value: iata, ambiguous: false };
  }

  return { value: cleaned, ambiguous: false };
}

export function parseTripType(input: string): TripType | null {
  const text = input.toLowerCase();

  if (
    text.includes("one-way") ||
    text.includes("one way") ||
    /\boneway\b/.test(text) ||
    /\bone\s*w[a-z]+\b/.test(text) ||
    /\b1[-\s]?way\b/.test(text) ||
    /\bsingle\b/.test(text) ||
    /\bow\b/.test(text)
  ) {
    return "one-way";
  }

  if (
    text.includes("round-trip") ||
    text.includes("round trip") ||
    /\broundtrip\b/.test(text) ||
    /\bround\s*t[a-z]+\b/.test(text) ||
    text.includes("return")
  ) {
    return "round-trip";
  }

  return null;
}

function isRealDate(ymd: string): boolean {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) {
    return false;
  }

  const dt = new Date(Date.UTC(year, month - 1, day));

  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() + 1 === month &&
    dt.getUTCDate() === day
  );
}

export function parseDateYMD(input: string): string | null {
  const match = input.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (!match) {
    return null;
  }

  const ymd = match[0];
  return isRealDate(ymd) ? ymd : null;
}

function parseAgeList(raw: string): number[] {
  const ages = (raw.match(/\d{1,2}/g) ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 17);

  return ages;
}

function parseAgesByKeyword(text: string, keyword: "child" | "children" | "infant" | "infants"): number[] {
  const direct = text.match(new RegExp(`${keyword}\\s*ages?\\s*[:=-]?\\s*([\\d,\\s]+)`, "i"));
  if (direct?.[1]) {
    return parseAgeList(direct[1]);
  }

  const grouped = text.match(new RegExp(`${keyword}\\s*\\(([^)]+)\\)`, "i"));
  if (grouped?.[1]) {
    return parseAgeList(grouped[1]);
  }

  const single = text.match(new RegExp(`${keyword}\\s*age\\s*(\\d{1,2})`, "i"));
  if (single?.[1]) {
    return parseAgeList(single[1]);
  }

  return [];
}

export function parsePassengers(input: string): PassengerCounts | null {
  const text = input.toLowerCase();
  const compact = text.replace(/\s+/g, " ").trim();

  const slashFormat = compact.match(/^(\d+)\s*[/,-]\s*(\d+)\s*[/,-]\s*(\d+)$/);
  if (slashFormat) {
    const adults = Number(slashFormat[1]);
    const children = Number(slashFormat[2]);
    const infants = Number(slashFormat[3]);

    if (adults > 20 || children > 20 || infants > 20) {
      return null;
    }

    return {
      adults: Math.max(1, adults),
      children: Math.max(0, children),
      infants: Math.max(0, infants),
      children_ages: [],
      infants_ages: []
    };
  }

  if (compact === "adult" || compact === "adults") {
    return { adults: 1, children: 0, infants: 0, children_ages: [], infants_ages: [] };
  }

  const normalizedText = compact
    .replace(/\bkids?\b/g, "children")
    .replace(/\bbabies\b/g, "infants");

  const adultsMatch = normalizedText.match(/(\d+)\s*adults?/);
  const childrenMatch = normalizedText.match(/(\d+)\s*(children?|child)/);
  const infantsMatch = normalizedText.match(/(\d+)\s*(infants?|infant)/);

  if (adultsMatch || childrenMatch || infantsMatch) {
    const adults = Number(adultsMatch?.[1] ?? "0");
    const children = Number(childrenMatch?.[1] ?? "0");
    const infants = Number(infantsMatch?.[1] ?? "0");

    if (Number.isNaN(adults) || Number.isNaN(children) || Number.isNaN(infants)) {
      return null;
    }

    const childrenAges = parseAgesByKeyword(normalizedText, "children").length
      ? parseAgesByKeyword(normalizedText, "children")
      : parseAgesByKeyword(normalizedText, "child");
    const infantsAges = parseAgesByKeyword(normalizedText, "infants").length
      ? parseAgesByKeyword(normalizedText, "infants")
      : parseAgesByKeyword(normalizedText, "infant");

    return {
      adults: Math.max(1, adults),
      children: Math.max(0, children),
      infants: Math.max(0, infants),
      children_ages: childrenAges.slice(0, Math.max(0, children)),
      infants_ages: infantsAges.slice(0, Math.max(0, infants))
    };
  }

  const numericOnly = text.match(/^\d+$/);
  if (numericOnly) {
    const adults = Number(numericOnly[0]);
    return {
      adults: Math.max(1, adults),
      children: 0,
      infants: 0,
      children_ages: [],
      infants_ages: []
    };
  }

  const passengersMatch = text.match(/(\d+)\s*(passengers?|people|travelers|travellers)/);
  if (passengersMatch) {
    const adults = Number(passengersMatch[1]);
    return {
      adults: Math.max(1, adults),
      children: 0,
      infants: 0,
      children_ages: [],
      infants_ages: []
    };
  }

  const pairRegex = /(\d+)\s*([a-z]+)/g;
  const pairs = Array.from(compact.matchAll(pairRegex));
  if (pairs.length > 0) {
    let adults = 0;
    let children = 0;
    let infants = 0;

    for (const pair of pairs) {
      const value = Number(pair[1] ?? "0");
      const label = pair[2] ?? "";

      if (!Number.isFinite(value) || value < 0) {
        continue;
      }

      const match = bestFuzzyMatch(label, ["adult", "adults", "child", "children", "infant", "infants"], 2);
      if (!match) {
        continue;
      }

      if (match.startsWith("adult")) {
        adults = value;
      } else if (match.startsWith("child") || match.startsWith("children")) {
        children = value;
      } else if (match.startsWith("infant")) {
        infants = value;
      }
    }

    if (adults > 0 || children > 0 || infants > 0) {
      return {
        adults: Math.max(1, adults),
        children: Math.max(0, children),
        infants: Math.max(0, infants),
        children_ages: [],
        infants_ages: []
      };
    }
  }

  return null;
}

export function parseCabinClass(input: string): CabinClass | null {
  const text = input.toLowerCase();

  if (
    (text.includes("premium") && text.includes("economy")) ||
    /premi?um\s*eco(nomy|nomy|nmy)?/.test(text)
  ) {
    return "premium_economy";
  }

  if (text.includes("business") || text.includes("buisness") || text.includes("busines") || /\bbiz\b/.test(text)) {
    return "business";
  }

  if (text.includes("first") || text.includes("frist")) {
    return "first";
  }

  if (text.includes("economy") || text.includes("econmy") || text.includes("econ")) {
    return "economy";
  }

  return null;
}

export function parseRoute(input: string): { origin: string; destination: string } | null {
  const match = input.match(/from\s+(.+?)\s+to\s+(.+)/i);
  if (!match) {
    return null;
  }

  const from = normalizeAirportInput(match[1]);
  const to = normalizeAirportInput(match[2]);

  if (from.ambiguous || to.ambiguous || !from.value || !to.value) {
    return null;
  }

  return {
    origin: from.value,
    destination: to.value
  };
}
