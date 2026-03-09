import {
  FLIGHT_SLOT_QUESTIONS,
  REQUIRED_FLIGHT_SLOT_ORDER,
  type FlightSearchState,
  type RequiredFlightSlot
} from "@/flight/types";
import {
  normalizeAirportInput,
  parseCabinClass,
  parseDateYMD,
  parsePassengers,
  parseRoute,
  parseTripType
} from "@/flight/normalize";

function cloneState(state: FlightSearchState | null): FlightSearchState {
  return {
    status: state?.status ?? "collecting",
    ...state
  };
}

function parseDirectAssignments(state: FlightSearchState, message: string): string[] {
  const notes: string[] = [];
  const route = parseRoute(message);

  if (route) {
    const originChanged = state.origin && state.origin !== route.origin;
    const destinationChanged = state.destination && state.destination !== route.destination;

    state.origin = route.origin;
    state.destination = route.destination;

    if (originChanged || destinationChanged) {
      notes.push(`Updated route: ${route.origin} to ${route.destination}.`);
    }
  }

  const explicitOrigin = message.match(/origin\s*[:=-]\s*(.+)/i)?.[1];
  const changedOrigin = message.match(/\b(?:change|update|modify)\s+(?:my\s+)?origin(?:\s+(?:to|as))?\s+(.+)/i)?.[1];
  const originInput = explicitOrigin ?? changedOrigin;
  if (originInput) {
    const normalized = normalizeAirportInput(originInput);
    if (!normalized.ambiguous && normalized.value) {
      const changed = state.origin && state.origin !== normalized.value;
      state.origin = normalized.value;
      if (changed) {
        notes.push(`Updated origin to ${normalized.value}.`);
      }
    }
  }

  const explicitDestination = message.match(/destination\s*[:=-]\s*(.+)/i)?.[1];
  const changedDestination =
    message.match(/\b(?:change|update|modify)\s+(?:my\s+)?destination(?:\s+(?:to|as))?\s+(.+)/i)?.[1];
  const destinationInput = explicitDestination ?? changedDestination;
  if (destinationInput) {
    const normalized = normalizeAirportInput(destinationInput);
    if (!normalized.ambiguous && normalized.value) {
      const changed = state.destination && state.destination !== normalized.value;
      state.destination = normalized.value;
      if (changed) {
        notes.push(`Updated destination to ${normalized.value}.`);
      }
    }
  }

  const trip = parseTripType(message);
  if (trip && state.trip_type !== trip) {
    state.trip_type = trip;
    if (trip === "one-way") {
      state.return_date = undefined;
    }
    notes.push(`Updated trip type to ${trip}.`);
  }

  const cabin = parseCabinClass(message);
  if (cabin && state.cabin_class !== cabin) {
    state.cabin_class = cabin;
    notes.push(`Updated cabin class to ${cabin.replace("_", " ")}.`);
  }

  const passengers = parsePassengers(message);
  if (passengers) {
    const current = state.passengers;
    const changed =
      !current ||
      current.adults !== passengers.adults ||
      current.children !== passengers.children ||
      current.infants !== passengers.infants;

    if (changed) {
      state.passengers = passengers;
      notes.push(
        `Updated passengers to Adults ${passengers.adults}, Children ${passengers.children}, Infants ${passengers.infants}.`
      );
    }
  }

  const allDates = message.match(/\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/g) ?? [];
  const departByLabel = message.match(/depart(?:ure)?\D*(\d{4}[-/.]\d{2}[-/.]\d{2})/i)?.[1];
  const returnByLabel = message.match(/return\D*(\d{4}[-/.]\d{2}[-/.]\d{2})/i)?.[1];

  const parsedDepartByLabel = departByLabel ? parseDateYMD(departByLabel) : null;
  const parsedReturnByLabel = returnByLabel ? parseDateYMD(returnByLabel) : null;

  if (parsedDepartByLabel) {
    if (state.depart_date !== parsedDepartByLabel) {
      state.depart_date = parsedDepartByLabel;
      notes.push(`Updated departure date to ${departByLabel}.`);
    }
  }

  if (parsedReturnByLabel) {
    if (state.return_date !== parsedReturnByLabel) {
      state.return_date = parsedReturnByLabel;
      notes.push(`Updated return date to ${returnByLabel}.`);
    }
  }

  if (!departByLabel && !returnByLabel && allDates.length === 1) {
    const singleDate = allDates[0];
    if (singleDate) {
      const date = parseDateYMD(singleDate);
      if (date) {
        const nextSlot = getNextRequiredSlot(state);
        const updateDeparture =
          nextSlot === "depart_date" || (!nextSlot && (!state.depart_date || !/\breturn\b/i.test(message)));
        const updateReturn =
          nextSlot === "return_date" ||
          (!nextSlot && state.trip_type === "round-trip" && /\breturn\b/i.test(message));

        if (updateDeparture && state.depart_date !== date) {
          state.depart_date = date;
          notes.push(`Updated departure date to ${date}.`);
        } else if (updateReturn && state.return_date !== date) {
          state.return_date = date;
          notes.push(`Updated return date to ${date}.`);
        }
      }
    }
  }

  if (!departByLabel && !returnByLabel && allDates.length >= 2) {
    const firstRaw = allDates[0];
    const secondRaw = allDates[1];
    const first = firstRaw ? parseDateYMD(firstRaw) : null;
    const second = secondRaw ? parseDateYMD(secondRaw) : null;

    if (first && second) {
      if (state.depart_date !== first) {
        state.depart_date = first;
      }

      if (state.trip_type === "round-trip" && state.return_date !== second) {
        state.return_date = second;
      }
    }
  }

  return notes;
}

function applyFlightChangeRequest(state: FlightSearchState, message: string, updateNotes: string[]): void {
  if (updateNotes.length > 0) {
    return;
  }

  const text = message.toLowerCase();
  const hasChangeIntent = /\b(change|modify|update|edit|refine|adjust)\b/.test(text);

  if (!hasChangeIntent) {
    return;
  }

  if (/\b(date|dates|departure|return)\b/.test(text)) {
    state.depart_date = undefined;
    if (state.trip_type === "round-trip") {
      state.return_date = undefined;
    }
    updateNotes.push("Sure, let's update your travel dates.");
    return;
  }

  if (/\b(passenger|passengers|adult|adults|child|children|infant|infants)\b/.test(text)) {
    state.passengers = undefined;
    updateNotes.push("Sure, let's update passenger details.");
    return;
  }

  if (/\b(cabin|class|economy|premium|business|first)\b/.test(text)) {
    state.cabin_class = undefined;
    updateNotes.push("Sure, let's update cabin class.");
    return;
  }

  if (/\b(route|origin|destination|departing from|flying to)\b/.test(text)) {
    state.origin = undefined;
    state.destination = undefined;
    updateNotes.push("Sure, let's update your route.");
  }
}

function parseExpectedSlotValue(
  slot: RequiredFlightSlot,
  message: string
): { value?: string | FlightSearchState["passengers"]; error?: string } {
  if (slot === "origin" || slot === "destination") {
    const normalized = normalizeAirportInput(message);
    if (normalized.ambiguous || !normalized.value) {
      const slotQuestion =
        slot === "origin" ? FLIGHT_SLOT_QUESTIONS.origin : FLIGHT_SLOT_QUESTIONS.destination;

      return {
        error: normalized.clarificationQuestion
          ? `${normalized.clarificationQuestion} ${slotQuestion}`
          : slotQuestion
      };
    }

    return { value: normalized.value };
  }

  if (slot === "trip_type") {
    const trip = parseTripType(message);
    if (!trip) {
      return { error: "Please answer one-way or round-trip." };
    }

    return { value: trip };
  }

  if (slot === "depart_date" || slot === "return_date") {
    const date = parseDateYMD(message);
    if (!date) {
      return { error: "Please provide the date in YYYY-MM-DD format." };
    }

    return { value: date };
  }

  if (slot === "passengers") {
    const passengers = parsePassengers(message);
    if (!passengers) {
      return { error: "Please provide passengers as Adults / Children (ages) / Infants." };
    }

    return { value: passengers };
  }

  if (slot === "cabin_class") {
    const cabin = parseCabinClass(message);
    if (!cabin) {
      return { error: "Please choose Economy, Premium Economy, Business, or First." };
    }

    return { value: cabin };
  }

  return { error: "Unsupported slot." };
}

function validateDateOrder(state: FlightSearchState): string | null {
  if (!state.depart_date || !state.return_date || state.trip_type !== "round-trip") {
    return null;
  }

  if (state.return_date < state.depart_date) {
    state.return_date = undefined;
    return "Return date cannot be earlier than departure date.";
  }

  return null;
}

export function getNextRequiredSlot(state: FlightSearchState): RequiredFlightSlot | null {
  for (const slot of REQUIRED_FLIGHT_SLOT_ORDER) {
    if (slot === "return_date" && state.trip_type !== "round-trip") {
      continue;
    }

    if (slot === "origin" && !state.origin) {
      return slot;
    }

    if (slot === "destination" && !state.destination) {
      return slot;
    }

    if (slot === "trip_type" && !state.trip_type) {
      return slot;
    }

    if (slot === "depart_date" && !state.depart_date) {
      return slot;
    }

    if (slot === "return_date" && !state.return_date) {
      return slot;
    }

    if (slot === "passengers" && !state.passengers) {
      return slot;
    }

    if (slot === "cabin_class" && !state.cabin_class) {
      return slot;
    }
  }

  return null;
}

export function isFlightStateComplete(state: FlightSearchState): boolean {
  return getNextRequiredSlot(state) === null;
}

export function getQuestionForNextSlot(state: FlightSearchState): string | null {
  const slot = getNextRequiredSlot(state);
  return slot ? FLIGHT_SLOT_QUESTIONS[slot] : null;
}

export function applyUserMessageToFlightState(existingState: FlightSearchState | null, message: string): {
  state: FlightSearchState;
  updateNotes: string[];
  responseHint?: string;
} {
  const state = cloneState(existingState);
  state.status = "collecting";

  const updateNotes = parseDirectAssignments(state, message);
  applyFlightChangeRequest(state, message, updateNotes);

  const missingSlot = getNextRequiredSlot(state);

  if (missingSlot) {
    const parsed = parseExpectedSlotValue(missingSlot, message);

    if (parsed.value !== undefined) {
      if (missingSlot === "origin") {
        state.origin = parsed.value as string;
      } else if (missingSlot === "destination") {
        state.destination = parsed.value as string;
      } else if (missingSlot === "trip_type") {
        state.trip_type = parsed.value as FlightSearchState["trip_type"];
        if (state.trip_type === "one-way") {
          state.return_date = undefined;
        }
      } else if (missingSlot === "depart_date") {
        state.depart_date = parsed.value as string;
      } else if (missingSlot === "return_date") {
        state.return_date = parsed.value as string;
      } else if (missingSlot === "passengers") {
        state.passengers = parsed.value as FlightSearchState["passengers"];
      } else if (missingSlot === "cabin_class") {
        state.cabin_class = parsed.value as FlightSearchState["cabin_class"];
      }
    } else if (parsed.error && updateNotes.length === 0) {
      state.last_asked_slot = missingSlot;
      return {
        state,
        updateNotes,
        responseHint: parsed.error
      };
    }
  }

  const dateError = validateDateOrder(state);
  if (dateError) {
    state.last_asked_slot = "return_date";
    return {
      state,
      updateNotes,
      responseHint: `${dateError} ${FLIGHT_SLOT_QUESTIONS.return_date}`
    };
  }

  const nextSlot = getNextRequiredSlot(state);
  if (nextSlot) {
    state.last_asked_slot = nextSlot;
    return {
      state,
      updateNotes,
      responseHint: FLIGHT_SLOT_QUESTIONS[nextSlot]
    };
  }

  state.status = "ready";
  return {
    state,
    updateNotes
  };
}
