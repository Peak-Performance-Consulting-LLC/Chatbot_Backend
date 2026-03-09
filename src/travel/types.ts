export const TRAVEL_SERVICES = ["flights", "hotels", "cars", "cruises"] as const;

export type TravelService = (typeof TRAVEL_SERVICES)[number];

export type ServiceSlotType = "text" | "date" | "number" | "option";

export type ServiceSlotConfig = {
  key: string;
  question: string;
  type: ServiceSlotType;
  min?: number;
  max?: number;
  options?: string[];
};

export type TravelServiceState = {
  service: Exclude<TravelService, "flights">;
  status: "collecting" | "ready" | "completed";
  slots: Record<string, string | number>;
  last_asked_slot?: string;
};

export const SERVICE_SLOT_CONFIG: Record<Exclude<TravelService, "flights">, ServiceSlotConfig[]> = {
  hotels: [
    {
      key: "destination",
      type: "text",
      question: "Which city or destination do you want to stay in?"
    },
    {
      key: "check_in_date",
      type: "date",
      question: "What is your check-in date? (YYYY-MM-DD)"
    },
    {
      key: "check_out_date",
      type: "date",
      question: "What is your check-out date? (YYYY-MM-DD)"
    },
    {
      key: "guests",
      type: "number",
      min: 1,
      max: 12,
      question: "How many guests are traveling?"
    },
    {
      key: "rooms",
      type: "number",
      min: 1,
      max: 6,
      question: "How many rooms do you need?"
    }
  ],
  cars: [
    {
      key: "pickup_location",
      type: "text",
      question: "Where do you need the car pickup?"
    },
    {
      key: "pickup_date",
      type: "date",
      question: "Pickup date? (YYYY-MM-DD)"
    },
    {
      key: "dropoff_date",
      type: "date",
      question: "Drop-off date? (YYYY-MM-DD)"
    },
    {
      key: "driver_age",
      type: "number",
      min: 18,
      max: 90,
      question: "What is the primary driver age?"
    },
    {
      key: "car_type",
      type: "option",
      options: ["Economy", "SUV", "Luxury", "Van"],
      question: "Preferred car type?"
    }
  ],
  cruises: [
    {
      key: "destination",
      type: "text",
      question: "Which cruise destination or region are you interested in?"
    },
    {
      key: "departure_date",
      type: "date",
      question: "Preferred departure date? (YYYY-MM-DD)"
    },
    {
      key: "duration_nights",
      type: "number",
      min: 2,
      max: 30,
      question: "How many nights do you prefer?"
    },
    {
      key: "travelers",
      type: "number",
      min: 1,
      max: 12,
      question: "How many travelers are sailing?"
    },
    {
      key: "cabin_type",
      type: "option",
      options: ["Inside", "Oceanview", "Balcony", "Suite"],
      question: "Preferred cabin type?"
    }
  ]
};
