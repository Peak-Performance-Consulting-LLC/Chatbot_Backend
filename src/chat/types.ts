export type ChatRole = "user" | "assistant" | "system";

export type MessageIntent =
  | "flight_search"
  | "knowledge"
  | "payment_support"
  | "support"
  | "greeting"
  | "service_request";

export type MessageMetadata = {
  quick_replies?: string[];
  service_request?: {
    service: "hotels" | "cars" | "cruises";
    status: string;
    payload: Record<string, string | number>;
  };
  flight_deals?: Array<{
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
  }>;
  flight_payload?: Record<string, unknown>;
  flight_ui?: {
    phase: "collecting" | "results" | "error";
    next_slot?: "origin" | "destination" | "trip_type" | "depart_date" | "return_date" | "passengers" | "cabin_class";
    state?: {
      origin?: string;
      destination?: string;
      trip_type?: string;
      depart_date?: string;
      return_date?: string;
      passengers?: {
        adults: number;
        children: number;
        infants: number;
      };
      cabin_class?: string;
    };
    airport_suggestions?: Array<{
      code: string;
      label: string;
    }>;
  };
  service_ui?: {
    phase: "collecting" | "submitted";
    service: "hotels" | "cars" | "cruises";
    next_slot?: string;
    next_slot_type?: "text" | "date" | "number" | "option";
    next_slot_min?: number;
    next_slot_max?: number;
    options?: string[];
    state?: Record<string, string | number>;
  };
  call_cta?: {
    number: string;
    tel: string;
    label: string;
  };
  source_urls?: string[];
  no_rag_match?: boolean;
  [key: string]: unknown;
};

export type ChatThread = {
  id: string;
  tenant_id: string;
  device_id: string;
  title: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
};

export type ChatMessage = {
  id: string;
  chat_id: string;
  role: ChatRole;
  content: string;
  metadata: MessageMetadata | null;
  created_at: string;
};
