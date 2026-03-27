export type ChatRole = "user" | "assistant" | "system";

export type ConversationMode =
  | "ai_only"
  | "handoff_pending"
  | "agent_active"
  | "copilot"
  | "returned_to_ai"
  | "closed";

export type ConversationStatus =
  | "active"
  | "waiting"
  | "assigned"
  | "closed"
  | "archived";

export type SenderType = "visitor" | "ai" | "agent" | "system";

export type MessageIntent =
  | "flight_search"
  | "knowledge"
  | "payment_support"
  | "support"
  | "greeting"
  | "service_request";

export type MessageMetadata = {
  contact_capture?: {
    required: boolean;
    prompt: string;
    fields: Array<"name" | "email" | "phone">;
  };
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
  workspace_id: string | null;
  queue_id: string | null;
  device_id: string;
  title: string;
  summary: string | null;
  conversation_mode: ConversationMode;
  conversation_status: ConversationStatus;
  assigned_agent_id: string | null;
  handoff_requested_at: string | null;
  assigned_at: string | null;
  closed_at: string | null;
  priority: number;
  sla_breached: boolean;
  sla_started_at: string | null;
  sla_first_response_due_at: string | null;
  first_agent_response_at: string | null;
  sla_warning_sent_at: string | null;
  sla_breached_at: string | null;
  overflowed_at: string | null;
  visitor_is_vip: boolean;
  routing_skill: string | null;
  archived_at: string | null;
  visitor_name?: string | null;
  visitor_email?: string | null;
  visitor_phone?: string | null;
  visitor_contact_captured?: boolean;
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
  sender_type: SenderType;
  sender_id: string | null;
  is_internal: boolean;
  is_draft: boolean;
  dedupe_key: string | null;
  created_at: string;
};

export type ConversationEvent = {
  id: string;
  chat_id: string;
  event_type: string;
  actor_id: string | null;
  actor_type: string | null;
  old_mode: ConversationMode | null;
  new_mode: ConversationMode | null;
  metadata: Record<string, unknown>;
  created_at: string;
};
