import type { MessageMetadata } from "@/chat/types";
import type { CallCta } from "@/flight/format";
import { searchHotelDeals } from "@/travel/hotelClient";
import { SERVICE_SLOT_CONFIG, type TravelServiceState } from "@/travel/types";

const serviceLabels: Record<TravelServiceState["service"], string> = {
  hotels: "hotel stay",
  cars: "car rental",
  cruises: "cruise"
};

function getSlotInfo(state: TravelServiceState) {
  const config = SERVICE_SLOT_CONFIG[state.service];
  const nextSlot = config.find((slot) => state.slots[slot.key] === undefined || state.slots[slot.key] === "");
  return nextSlot ?? null;
}

function formatStateSummary(state: TravelServiceState): string {
  return Object.entries(state.slots)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`)
    .join(", ");
}

function buildHotelFallbackDeals(state: TravelServiceState): NonNullable<MessageMetadata["hotel_deals"]> {
  const destination = String(state.slots.destination ?? "your destination");
  const rooms = Number(state.slots.rooms ?? 1);
  const guests = Number(state.slots.guests ?? 1);
  const base = Math.max(89, destination.length * 9 + guests * 12 + rooms * 18);

  return [
    {
      id: "hotel-comfort",
      name: `${destination} Central Stay`,
      destination,
      area: "Central district",
      nightly_price: `$${base}/night`,
      rating: "4.4",
      highlights: ["Flexible dates", "Breakfast available", "Near transit"],
      description: `A comfortable central hotel option in ${destination}, suited for easy access to local attractions and transport.`,
      amenities: ["Breakfast", "Wi-Fi", "Flexible booking"]
    },
    {
      id: "hotel-boutique",
      name: `${destination} Boutique Hotel`,
      destination,
      area: "Popular neighborhood",
      nightly_price: `$${base + 37}/night`,
      rating: "4.6",
      highlights: ["Guest favorite", "Free Wi-Fi", "Great for couples"],
      description: `A stylish boutique stay in ${destination} with well-rated rooms and convenient nearby dining.`,
      amenities: ["Free Wi-Fi", "Boutique rooms", "Dining nearby"]
    },
    {
      id: "hotel-premium",
      name: `${destination} Premium Suites`,
      destination,
      area: "Landmark area",
      nightly_price: `$${base + 82}/night`,
      rating: "4.8",
      highlights: ["Suite options", "Concierge support", "Top rated"],
      description: `A premium suite-focused option in ${destination} for travelers who want extra space and concierge support.`,
      amenities: ["Suites", "Concierge", "Premium location"]
    }
  ];
}

export function buildServiceCollectingMetadata(state: TravelServiceState): MessageMetadata {
  const nextSlot = getSlotInfo(state);

  return {
    service_ui: {
      phase: "collecting",
      service: state.service,
      next_slot: nextSlot?.key,
      next_slot_type: nextSlot?.type,
      next_slot_min: nextSlot?.min,
      next_slot_max: nextSlot?.max,
      options: nextSlot?.options,
      state: state.slots
    },
    service_request: {
      service: state.service,
      status: state.status,
      payload: state.slots
    }
  };
}

export async function buildServiceCompletedMessage(input: {
  state: TravelServiceState;
  callCta: CallCta;
}): Promise<{ text: string; metadata: MessageMetadata }> {
  if (input.state.service === "hotels") {
    const destination = String(input.state.slots.destination ?? "your destination");
    const apiDeals = await searchHotelDeals(input.state);
    const deals = apiDeals.length > 0 ? apiDeals : buildHotelFallbackDeals(input.state);

    return {
      text: `Here are hotel deals I found for ${destination}.`,
      metadata: {
        call_cta: input.callCta,
        hotel_deals: deals,
        service_request: {
          service: input.state.service,
          status: "ready_for_specialist",
          payload: input.state.slots
        },
        service_ui: {
          phase: "submitted",
          service: input.state.service,
          state: input.state.slots
        },
        quick_replies: ["Change destination", "Change dates", "Change guests", input.callCta.label]
      }
    };
  }

  const serviceLabel = serviceLabels[input.state.service];
  const summary = formatStateSummary(input.state);

  const text = [
    `Great, I’ve captured your ${serviceLabel} request details.`,
    summary ? `Details: ${summary}.` : "",
    `A travel specialist can now secure the best available options. [${input.callCta.label}](${input.callCta.tel})`,
    "Want to adjust anything before we connect you?"
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text,
    metadata: {
      call_cta: input.callCta,
      service_request: {
        service: input.state.service,
        status: "ready_for_specialist",
        payload: input.state.slots
      },
      service_ui: {
        phase: "submitted",
        service: input.state.service,
        state: input.state.slots
      },
      quick_replies: ["Change dates", "Change location", "Start over", "Connect with a specialist"]
    }
  };
}

export function buildServicesQuickReplies(services: Array<"flights" | "hotels" | "cars" | "cruises">): string[] {
  const quickReplies: string[] = [];

  if (services.includes("flights")) {
    quickReplies.push("Find flight deals");
  }
  if (services.includes("hotels")) {
    quickReplies.push("Find hotel deals");
  }
  if (services.includes("cars")) {
    quickReplies.push("Find rental cars");
  }
  if (services.includes("cruises")) {
    quickReplies.push("Find cruise deals");
  }

  quickReplies.push("Connect with a specialist");
  return quickReplies;
}
