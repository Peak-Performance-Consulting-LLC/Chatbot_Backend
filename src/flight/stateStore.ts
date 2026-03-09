import type { FlightSearchState } from "@/flight/types";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";

const PRIMARY_STATE_TABLE = "flight_search_sessions";
const LEGACY_STATE_TABLE = "flight_search_states";
const STATE_TABLES = [PRIMARY_STATE_TABLE, LEGACY_STATE_TABLE] as const;

function isMissingRelationError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("could not find the table") ||
    normalized.includes("does not exist") ||
    normalized.includes("schema cache")
  );
}

function toLegacyStatus(status: FlightSearchState["status"]) {
  if (status === "done") {
    return "completed";
  }

  if (status === "completed") {
    return "completed";
  }

  return status;
}

function fromStoredStatus(status: string | undefined): FlightSearchState["status"] {
  if (status === "completed") {
    return "done";
  }

  if (status === "done" || status === "ready" || status === "collecting") {
    return status;
  }

  return "collecting";
}

type FlightStateRow = {
  chat_id: string;
  tenant_id: string;
  state: FlightSearchState;
  status: "collecting" | "ready" | "done" | "completed";
  updated_at: string;
};

export async function getFlightState(chatId: string): Promise<FlightSearchState | null> {
  let lastError: string | null = null;

  for (const table of STATE_TABLES) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("state, status")
      .eq("chat_id", chatId)
      .maybeSingle();

    if (error) {
      if (isMissingRelationError(error.message)) {
        lastError = error.message;
        continue;
      }
      throw new HttpError(500, `Failed to load flight search state: ${error.message}`);
    }

    if (!data?.state) {
      return null;
    }

    const state = data.state as FlightSearchState;
    const status = fromStoredStatus(
      typeof (data as { status?: unknown }).status === "string"
        ? ((data as { status?: unknown }).status as string)
        : state.status
    );

    return {
      ...state,
      status
    };
  }

  throw new HttpError(
    500,
    `Failed to load flight search state: ${
      lastError ?? "Neither flight_search_sessions nor flight_search_states is available"
    }`
  );
}

export async function upsertFlightState(chatId: string, tenantId: string, state: FlightSearchState): Promise<void> {
  let lastError: string | null = null;

  for (const table of STATE_TABLES) {
    const payload: FlightStateRow = {
      chat_id: chatId,
      tenant_id: tenantId,
      state,
      status: table === LEGACY_STATE_TABLE ? toLegacyStatus(state.status) : state.status,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin.from(table).upsert(payload, { onConflict: "chat_id" });

    if (!error) {
      return;
    }

    if (isMissingRelationError(error.message)) {
      lastError = error.message;
      continue;
    }

    throw new HttpError(500, `Failed to save flight search state: ${error.message}`);
  }

  throw new HttpError(
    500,
    `Failed to save flight search state: ${
      lastError ?? "Neither flight_search_sessions nor flight_search_states is available"
    }`
  );
}

export async function clearFlightState(chatId: string, tenantId: string): Promise<void> {
  let lastError: string | null = null;

  for (const table of STATE_TABLES) {
    const status = table === LEGACY_STATE_TABLE ? "completed" : "done";
    const payload: FlightStateRow = {
      chat_id: chatId,
      tenant_id: tenantId,
      state: { status },
      status,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin.from(table).upsert(payload, { onConflict: "chat_id" });

    if (!error) {
      return;
    }

    if (isMissingRelationError(error.message)) {
      lastError = error.message;
      continue;
    }

    throw new HttpError(500, `Failed to finalize flight search state: ${error.message}`);
  }

  throw new HttpError(
    500,
    `Failed to finalize flight search state: ${
      lastError ?? "Neither flight_search_sessions nor flight_search_states is available"
    }`
  );
}
