import { getEnv } from "@/config/env";
import type { MessageMetadata } from "@/chat/types";
import type { FlightDeal } from "@/flight/types";

const env = getEnv();

function telHrefFromNumber(number: string): string {
  const sanitized = number.replace(/[^+\d]/g, "");
  return `tel:${sanitized}`;
}

export type CallCta = {
  number: string;
  tel: string;
  label: string;
};

function dedupeKey(deal: FlightDeal): string {
  return [
    deal.airline?.trim().toLowerCase() ?? "",
    deal.origin?.trim().toUpperCase() ?? "",
    deal.destination?.trim().toUpperCase() ?? "",
    deal.departure_time?.trim() ?? "",
    deal.arrival_time?.trim() ?? "",
    deal.cabin_class?.trim().toLowerCase() ?? "",
    deal.total_price?.trim() ?? ""
  ].join("|");
}

export function pickTopUniqueDeals(deals: FlightDeal[], limit = 3): FlightDeal[] {
  const unique: FlightDeal[] = [];
  const seen = new Set<string>();

  for (const deal of deals) {
    const key = dedupeKey(deal);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(deal);

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

export function buildCallCtaMetadata(input?: { number?: string | null; label?: string | null }): CallCta {
  const number = input?.number?.trim() || env.CALL_CTA_NUMBER;
  const tel = telHrefFromNumber(number);
  const label = input?.label?.trim() || "Connect with a booking specialist";

  return {
    number,
    tel,
    label
  };
}

export function formatFlightDealsMessage(
  deals: FlightDeal[],
  callCta = buildCallCtaMetadata()
): { text: string; metadata: MessageMetadata } {
  const marketingCallText = "Call now to get up to 40% off";

  if (deals.length === 0) {
    return {
      text:
        `I couldn't find live fares for those details right now. ` +
        `${marketingCallText}. [Call now](${callCta.tel})`,
      metadata: {
        flight_deals: [],
        call_cta: callCta,
        quick_replies: [
          "Retry flight search",
          "Change dates",
          "Change passengers",
          "Change cabin class",
          "Change route",
          "Start over",
          "Connect with a specialist"
        ]
      }
    };
  }

  const topDeals = pickTopUniqueDeals(deals, 3);

  const text = [
    "Here are the top live flight deals I found.",
    "Use the cards below to compare fares, and tell me if you want to change route, dates, passengers, or cabin.",
    `For unpublished fares, use the specialist line below: [${marketingCallText}](${callCta.tel})`
  ].join("\n");

  return {
    text,
    metadata: {
      flight_deals: topDeals.map((deal) => ({
        id: deal.id,
        airline: deal.airline,
        total_price: deal.total_price,
        total_amount: deal.total_amount,
        total_currency: deal.total_currency,
        airline_logo: deal.airline_logo,
        departure_time: deal.departure_time,
        arrival_time: deal.arrival_time,
        origin: deal.origin,
        destination: deal.destination,
        stops: deal.stops,
        duration: deal.duration,
        cabin_class: deal.cabin_class
      })),
      call_cta: callCta,
      quick_replies: [
        "Refine by budget",
        "Change dates",
        "Change passengers",
        "Change cabin class",
        "Change route",
        "Start over",
        "Connect with a specialist"
      ]
    }
  };
}
