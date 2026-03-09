export type TripType = "one-way" | "round-trip";
export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export type PassengerCounts = {
  adults: number;
  children: number;
  infants: number;
  children_ages?: number[];
  infants_ages?: number[];
};

export type FlightDeal = {
  id: string;
  airline: string;
  total_price: string;
  total_amount?: string;
  total_currency?: string;
  airline_logo?: string;
  departure_time?: string;
  arrival_time?: string;
  origin?: string;
  destination?: string;
  stops?: number;
  duration?: string;
  cabin_class?: string;
  raw?: Record<string, unknown>;
};

export type FlightSearchState = {
  origin?: string;
  destination?: string;
  trip_type?: TripType;
  depart_date?: string;
  return_date?: string;
  passengers?: PassengerCounts;
  cabin_class?: CabinClass;
  status: "collecting" | "ready" | "done" | "completed";
  last_asked_slot?: RequiredFlightSlot;
};

export type RequiredFlightSlot =
  | "origin"
  | "destination"
  | "trip_type"
  | "depart_date"
  | "return_date"
  | "passengers"
  | "cabin_class";

export const REQUIRED_FLIGHT_SLOT_ORDER: RequiredFlightSlot[] = [
  "origin",
  "destination",
  "trip_type",
  "depart_date",
  "return_date",
  "passengers",
  "cabin_class"
];

export const FLIGHT_SLOT_QUESTIONS: Record<RequiredFlightSlot, string> = {
  origin: "From which city or airport are you departing?",
  destination: "Where are you flying to?",
  trip_type: "Is it one-way or round-trip?",
  depart_date: "What is your departure date? (YYYY-MM-DD)",
  return_date: "What is your return date? (YYYY-MM-DD)",
  passengers: "How many passengers? Please tell me Adults / Children / Infants.",
  cabin_class: "Cabin class: Economy, Premium Economy, Business, or First?"
};
