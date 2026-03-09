import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import type { TravelServiceState } from "@/travel/types";

type ServiceStateRow = {
  chat_id: string;
  tenant_id: string;
  state: TravelServiceState;
  status: "collecting" | "ready" | "completed";
  updated_at: string;
};

function isMissingServiceStateTable(message: string): boolean {
  return (
    message.includes("Could not find the table 'public.service_request_states'") ||
    message.includes('relation "public.service_request_states" does not exist')
  );
}

export async function getServiceState(chatId: string): Promise<TravelServiceState | null> {
  const { data, error } = await supabaseAdmin
    .from("service_request_states")
    .select("state")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    if (isMissingServiceStateTable(error.message)) {
      return null;
    }

    throw new HttpError(500, `Failed to load service request state: ${error.message}`);
  }

  if (!data?.state) {
    return null;
  }

  return data.state as TravelServiceState;
}

export async function upsertServiceState(chatId: string, tenantId: string, state: TravelServiceState): Promise<void> {
  const payload: ServiceStateRow = {
    chat_id: chatId,
    tenant_id: tenantId,
    state,
    status: state.status,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseAdmin
    .from("service_request_states")
    .upsert(payload, { onConflict: "chat_id" });

  if (error) {
    if (isMissingServiceStateTable(error.message)) {
      return;
    }

    throw new HttpError(500, `Failed to save service request state: ${error.message}`);
  }
}

export async function completeServiceState(chatId: string, tenantId: string, state: TravelServiceState): Promise<void> {
  await upsertServiceState(chatId, tenantId, {
    ...state,
    status: "completed"
  });
}
