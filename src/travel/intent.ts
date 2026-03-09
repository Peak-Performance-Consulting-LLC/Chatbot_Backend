import type { TravelService } from "@/travel/types";

const intentKeywords: Record<Exclude<TravelService, "flights">, string[]> = {
  hotels: ["hotel", "hotels", "stay", "accommodation", "resort", "room booking", "book hotel"],
  cars: ["car rental", "rent a car", "rental car", "vehicle rental", "hire car", "book car"],
  cruises: ["cruise", "cruises", "cruise booking", "voyage", "ship booking"]
};

const flowRestartKeywords = ["start over", "new search", "change details", "modify", "update", "refine"];
const bookingIntentKeywords = [
  "find",
  "search",
  "book",
  "booking",
  "deal",
  "deals",
  "rent",
  "rental",
  "quote",
  "price",
  "prices",
  "availability",
  "available",
  "reserve",
  "reservation",
  "need",
  "looking for"
];
const infoIntentKeywords = [
  "about",
  "information",
  "details",
  "service",
  "services",
  "provide",
  "available",
  "availability",
  "coverage",
  "country",
  "policy",
  "support",
  "contact",
  "phone",
  "number",
  "email",
  "help"
];
const serviceRestartKeywords = [
  ...flowRestartKeywords,
  "find hotel deals",
  "find rental cars",
  "find cruise deals",
  "book a hotel",
  "book hotel",
  "book a cruise",
  "book cruise",
  "rent a car",
  "search hotels",
  "search cars",
  "search cruises",
  "search again"
];

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function serviceMentioned(service: Exclude<TravelService, "flights">, text: string): boolean {
  if (intentKeywords[service].some((keyword) => text.includes(keyword))) {
    return true;
  }

  if (service === "hotels") {
    return text === "hotel" || text === "hotels";
  }

  if (service === "cars") {
    return text === "car" || text === "cars";
  }

  return text === "cruise" || text === "cruises";
}

export function detectServiceIntent(
  message: string,
  enabledServices: TravelService[]
): Exclude<TravelService, "flights"> | null {
  const text = normalizeText(message);

  const order: Array<Exclude<TravelService, "flights">> = ["hotels", "cars", "cruises"];
  for (const service of order) {
    if (!enabledServices.includes(service)) {
      continue;
    }

    if (!serviceMentioned(service, text)) {
      continue;
    }

    const hasBookingSignal = includesAny(text, bookingIntentKeywords) || includesAny(text, flowRestartKeywords);
    const hasInfoSignal = includesAny(text, infoIntentKeywords);

    if (hasBookingSignal && !hasInfoSignal) {
      return service;
    }

    if (text.length <= 24 && !hasInfoSignal) {
      return service;
    }

    if (text === service || text === service.slice(0, -1)) {
      return service;
    }
  }

  return null;
}

export function detectRequestedService(message: string): Exclude<TravelService, "flights"> | null {
  const text = normalizeText(message);
  const order: Array<Exclude<TravelService, "flights">> = ["hotels", "cars", "cruises"];
  for (const service of order) {
    if (serviceMentioned(service, text)) {
      return service;
    }
  }

  return null;
}

export function detectServiceUpdateIntent(message: string): boolean {
  const text = normalizeText(message);
  return flowRestartKeywords.some((keyword) => text.includes(keyword));
}

export function detectServiceRestartIntent(message: string): boolean {
  const text = normalizeText(message);

  if (serviceRestartKeywords.some((keyword) => text.includes(keyword))) {
    return true;
  }

  const requested = detectRequestedService(message);
  if (!requested) {
    return false;
  }

  return includesAny(text, bookingIntentKeywords);
}
