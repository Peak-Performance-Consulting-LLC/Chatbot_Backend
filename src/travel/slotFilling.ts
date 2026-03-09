import { parseDateYMD } from "@/flight/normalize";
import { SERVICE_SLOT_CONFIG, type ServiceSlotConfig, type TravelServiceState } from "@/travel/types";

type ServiceFlowResult = {
  state: TravelServiceState;
  updateNotes: string[];
  responseHint?: string;
};

function cloneState(state: TravelServiceState | null, service: TravelServiceState["service"]): TravelServiceState {
  return {
    service,
    status: state?.status ?? "collecting",
    slots: state?.slots ? { ...state.slots } : {},
    last_asked_slot: state?.last_asked_slot
  };
}

function slotList(service: TravelServiceState["service"]): ServiceSlotConfig[] {
  return SERVICE_SLOT_CONFIG[service];
}

export function getNextServiceSlot(state: TravelServiceState): ServiceSlotConfig | null {
  const slots = slotList(state.service);
  for (const slot of slots) {
    const value = state.slots[slot.key];
    if (value === undefined || value === null || value === "") {
      return slot;
    }
  }

  return null;
}

function parseNumberValue(input: string): number | null {
  const match = input.match(/\d+/);
  if (!match) {
    return null;
  }

  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value;
}

const interruptionKeywords = [
  "hi",
  "hello",
  "hey",
  "which",
  "country",
  "provide",
  "available",
  "offer",
  "support",
  "customer",
  "phone",
  "number",
  "email",
  "contact",
  "help",
  "policy",
  "refund",
  "cancellation",
  "payment",
  "card",
  "how",
  "what",
  "why",
  "tell me",
  "about"
];

function isLikelyInterruptionText(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("?")) {
    return true;
  }

  if (/^(what|how|why|when|where|who|can|could|would|do|does|is|are)\b/.test(normalized)) {
    return true;
  }

  return interruptionKeywords.some((keyword) => normalized.includes(keyword));
}

function isLocationSlotKey(key: string): boolean {
  return (
    key.includes("destination") ||
    key.includes("location") ||
    key.includes("pickup") ||
    key.includes("dropoff") ||
    key.includes("port")
  );
}

function isLikelyLocationValue(text: string): boolean {
  const cleaned = text
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) {
    return false;
  }

  if (isLikelyInterruptionText(cleaned)) {
    return false;
  }

  if (/\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/.test(cleaned)) {
    return false;
  }

  if (/\b(one[- ]?way|round[- ]?trip|economy|business|first|premium)\b/i.test(cleaned)) {
    return false;
  }

  const words = cleaned.split(" ");
  return words.length <= 6;
}

function parseSlotValue(slot: ServiceSlotConfig, message: string): { value?: string | number; error?: string } {
  const text = message.trim();
  if (!text) {
    return { error: slot.question };
  }

  if (slot.type === "text") {
    if (isLocationSlotKey(slot.key)) {
      if (!isLikelyLocationValue(text)) {
        return { error: slot.question };
      }
      return { value: text };
    }

    if (isLikelyInterruptionText(text)) {
      return { error: slot.question };
    }

    if (text.length < 2) {
      return { error: slot.question };
    }
    return { value: text };
  }

  if (slot.type === "date") {
    const parsed = parseDateYMD(text);
    if (!parsed) {
      return { error: "Please provide the date in YYYY-MM-DD format." };
    }

    return { value: parsed };
  }

  if (slot.type === "number") {
    const value = parseNumberValue(text);
    if (value === null) {
      return { error: slot.question };
    }

    if (slot.min !== undefined && value < slot.min) {
      return { error: `Please provide a value of at least ${slot.min}.` };
    }

    if (slot.max !== undefined && value > slot.max) {
      return { error: `Please provide a value up to ${slot.max}.` };
    }

    return { value };
  }

  if (slot.type === "option") {
    const options = slot.options ?? [];
    const normalized = text.toLowerCase();
    const matched = options.find((option) => option.toLowerCase() === normalized)
      ?? options.find((option) => option.toLowerCase().includes(normalized) || normalized.includes(option.toLowerCase()));

    if (!matched) {
      return { error: `Please choose one of: ${options.join(", ")}.` };
    }

    return { value: matched };
  }

  return { error: slot.question };
}

function applyChangeIntent(state: TravelServiceState, message: string, updateNotes: string[]) {
  const text = message.toLowerCase();
  if (!/\b(change|modify|update|edit|refine)\b/.test(text)) {
    return;
  }

  if (/\b(date|check-in|check-out|pickup|drop-off|departure)\b/.test(text)) {
    for (const key of Object.keys(state.slots)) {
      if (key.includes("date")) {
        delete state.slots[key];
      }
    }
    updateNotes.push("Sure, let's update the dates.");
    return;
  }

  if (/\b(destination|location|pickup)\b/.test(text)) {
    for (const key of Object.keys(state.slots)) {
      if (key.includes("destination") || key.includes("location") || key.includes("pickup")) {
        delete state.slots[key];
      }
    }
    updateNotes.push("Sure, let's update the location details.");
    return;
  }

  if (/\b(guest|room|traveler|driver|car type|cabin)\b/.test(text)) {
    for (const key of Object.keys(state.slots)) {
      if (
        key.includes("guest") ||
        key.includes("room") ||
        key.includes("traveler") ||
        key.includes("driver") ||
        key.includes("car_type") ||
        key.includes("cabin")
      ) {
        delete state.slots[key];
      }
    }
    updateNotes.push("Sure, let's update preferences.");
  }
}

function validateServiceState(state: TravelServiceState): string | null {
  if (state.service === "hotels") {
    const checkIn = state.slots.check_in_date;
    const checkOut = state.slots.check_out_date;
    if (typeof checkIn === "string" && typeof checkOut === "string" && checkOut < checkIn) {
      delete state.slots.check_out_date;
      return "Check-out date cannot be earlier than check-in date.";
    }
  }

  if (state.service === "cars") {
    const pickup = state.slots.pickup_date;
    const dropoff = state.slots.dropoff_date;
    if (typeof pickup === "string" && typeof dropoff === "string" && dropoff < pickup) {
      delete state.slots.dropoff_date;
      return "Drop-off date cannot be earlier than pickup date.";
    }
  }

  return null;
}

export function isLikelyServiceSlotAnswer(state: TravelServiceState | null, message: string): boolean {
  if (!state || state.status !== "collecting") {
    return false;
  }

  const slot = getNextServiceSlot(state);
  if (!slot) {
    return false;
  }

  return parseSlotValue(slot, message).value !== undefined;
}

export function applyUserMessageToServiceState(
  existingState: TravelServiceState | null,
  service: TravelServiceState["service"],
  message: string
): ServiceFlowResult {
  const state = cloneState(existingState, service);
  state.service = service;
  state.status = "collecting";

  const updateNotes: string[] = [];
  applyChangeIntent(state, message, updateNotes);

  let next = getNextServiceSlot(state);
  if (next) {
    const parsed = parseSlotValue(next, message);
    if (parsed.value !== undefined) {
      state.slots[next.key] = parsed.value;
      next = getNextServiceSlot(state);
    } else if (parsed.error && updateNotes.length === 0) {
      state.last_asked_slot = next.key;
      return {
        state,
        updateNotes,
        responseHint: parsed.error
      };
    }
  }

  const validation = validateServiceState(state);
  if (validation) {
    const newNext = getNextServiceSlot(state);
    state.last_asked_slot = newNext?.key;
    return {
      state,
      updateNotes,
      responseHint: `${validation} ${newNext?.question ?? ""}`.trim()
    };
  }

  next = getNextServiceSlot(state);
  if (next) {
    state.last_asked_slot = next.key;
    return {
      state,
      updateNotes,
      responseHint: next.question
    };
  }

  state.status = "ready";
  return { state, updateNotes };
}
