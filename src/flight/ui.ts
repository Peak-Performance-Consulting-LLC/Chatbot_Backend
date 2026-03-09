import type { MessageMetadata } from "@/chat/types";
import { defaultAirportSuggestions, suggestAirports } from "@/flight/airports";
import { getNextRequiredSlot } from "@/flight/slotFilling";
import type { FlightSearchState, RequiredFlightSlot } from "@/flight/types";

type AirportInput = {
  code: string;
  label: string;
};

function pickAirportSuggestions(state: FlightSearchState, slot: RequiredFlightSlot, userInputHint?: string): AirportInput[] {
  const anchor = userInputHint ?? (slot === "origin" ? state.origin : state.destination);
  const suggestions = anchor ? suggestAirports(anchor, 8) : defaultAirportSuggestions(8);
  return suggestions.map((item) => ({ code: item.code, label: item.label }));
}

function sanitizeState(state: FlightSearchState): NonNullable<MessageMetadata["flight_ui"]>["state"] {
  return {
    origin: state.origin,
    destination: state.destination,
    trip_type: state.trip_type,
    depart_date: state.depart_date,
    return_date: state.return_date,
    passengers: state.passengers,
    cabin_class: state.cabin_class
  };
}

export function buildCollectingFlightUiMetadata(state: FlightSearchState, userInputHint?: string): MessageMetadata {
  const nextSlot = getNextRequiredSlot(state);
  const flightUi: NonNullable<MessageMetadata["flight_ui"]> = {
    phase: "collecting",
    next_slot: nextSlot ?? undefined,
    state: sanitizeState(state)
  };

  if (nextSlot === "origin" || nextSlot === "destination") {
    flightUi.airport_suggestions = pickAirportSuggestions(state, nextSlot, userInputHint);
  }

  const metadata: MessageMetadata = {
    flight_ui: flightUi
  };

  return metadata;
}

export function buildResultsFlightUiMetadata(state: FlightSearchState): MessageMetadata {
  return {
    flight_ui: {
      phase: "results",
      state: sanitizeState(state)
    }
  };
}
