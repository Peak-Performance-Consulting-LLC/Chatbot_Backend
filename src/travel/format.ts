import type { MessageMetadata } from "@/chat/types";
import type { CallCta } from "@/flight/format";
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

export function buildServiceCompletedMessage(input: {
  state: TravelServiceState;
  callCta: CallCta;
}): { text: string; metadata: MessageMetadata } {
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
