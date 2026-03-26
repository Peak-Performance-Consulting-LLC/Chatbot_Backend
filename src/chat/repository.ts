import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import type {
  ChatMessage,
  ChatRole,
  ChatThread,
  ConversationEvent,
  ConversationMode,
  ConversationStatus,
  MessageMetadata,
  SenderType
} from "@/chat/types";

export type VisitorContact = {
  id: string;
  tenant_id: string;
  device_id: string;
  chat_id: string | null;
  full_name: string;
  email: string;
  phone_raw: string;
  phone_normalized: string;
  captured_at: string;
  created_at: string;
  updated_at: string;
};

export type ConversationCsat = {
  id: string;
  chat_id: string;
  tenant_id: string;
  workspace_id: string | null;
  rating: number;
  feedback: string | null;
  submitted_by: "visitor" | "agent" | "supervisor" | "system";
  submitted_at: string;
  created_at: string;
  updated_at: string;
};

function normalizePhoneNumber(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export async function createChatThread(input: {
  tenant_id: string;
  device_id: string;
  title?: string;
}): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .insert({
      tenant_id: input.tenant_id,
      workspace_id: input.tenant_id,
      device_id: input.device_id,
      title: input.title ?? "New chat",
      conversation_mode: "ai_only",
      conversation_status: "active"
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to create chat thread: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatThread;
}

export async function listChatThreads(tenantId: string, deviceId: string): Promise<ChatThread[]> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("device_id", deviceId)
    .order("last_message_at", { ascending: false });

  if (error) {
    throw new HttpError(500, `Failed to list chat threads: ${error.message}`);
  }

  return (data ?? []) as ChatThread[];
}

export async function assertChatOwnership(chatId: string, tenantId: string, deviceId: string): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .eq("id", chatId)
    .eq("tenant_id", tenantId)
    .eq("device_id", deviceId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to verify chat access: ${error.message}`);
  }

  if (!data) {
    throw new HttpError(404, "Chat thread not found");
  }

  return data as ChatThread;
}

export async function insertChatMessage(input: {
  chat_id: string;
  role: ChatRole;
  content: string;
  metadata?: MessageMetadata | null;
  sender_type?: SenderType;
  sender_id?: string | null;
  is_internal?: boolean;
  is_draft?: boolean;
  dedupe_key?: string | null;
}): Promise<ChatMessage> {
  const dedupeKey = input.dedupe_key?.trim() || null;
  if (dedupeKey) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("chat_id", input.chat_id)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();

    if (existingError) {
      throw new HttpError(500, `Failed to lookup dedupe message: ${existingError.message}`);
    }

    if (existing) {
      return existing as ChatMessage;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      chat_id: input.chat_id,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      sender_type: input.sender_type ?? (input.role === "user" ? "visitor" : input.role === "assistant" ? "ai" : "system"),
      sender_id: input.sender_id ?? null,
      is_internal: input.is_internal ?? false,
      is_draft: input.is_draft ?? false,
      dedupe_key: dedupeKey
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to save chat message: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatMessage;
}

export async function listChatMessages(
  chatId: string,
  options?: { includeInternal?: boolean }
): Promise<ChatMessage[]> {
  let query = supabaseAdmin
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (!options?.includeInternal) {
    query = query.eq("is_internal", false);
  }

  const { data, error } = await query;

  if (error) {
    throw new HttpError(500, `Failed to load messages: ${error.message}`);
  }

  return (data ?? []) as ChatMessage[];
}

export async function listRecentMessages(
  chatId: string,
  limit = 12,
  options?: { signal?: AbortSignal }
): Promise<ChatMessage[]> {
  const query = supabaseAdmin
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options?.signal) {
    query.abortSignal(options.signal);
  }

  const { data, error } = await query;

  if (error) {
    throw new HttpError(500, `Failed to load recent messages: ${error.message}`);
  }

  return ((data ?? []) as ChatMessage[]).reverse();
}

export async function touchChatThread(
  chatId: string,
  input?: {
    title?: string;
    summary?: string;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {
    last_message_at: new Date().toISOString()
  };

  if (input?.title) {
    payload.title = input.title;
  }

  if (input?.summary !== undefined) {
    payload.summary = input.summary;
  }

  const { error } = await supabaseAdmin.from("chats").update(payload).eq("id", chatId);

  if (error) {
    throw new HttpError(500, `Failed to update chat thread: ${error.message}`);
  }
}

export async function renameChatThread(chatId: string, title: string): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", chatId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to rename chat: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatThread;
}

export async function deleteChatThread(chatId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("chats").delete().eq("id", chatId);
  if (error) {
    throw new HttpError(500, `Failed to delete chat: ${error.message}`);
  }
}

export async function getVisitorContactByTenantDevice(
  tenantId: string,
  deviceId: string
): Promise<VisitorContact | null> {
  const { data, error } = await supabaseAdmin
    .from("visitor_contacts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("device_id", deviceId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load visitor contact: ${error.message}`);
  }

  return (data as VisitorContact | null) ?? null;
}

export async function upsertVisitorContact(input: {
  tenant_id: string;
  device_id: string;
  chat_id?: string;
  full_name: string;
  email: string;
  phone: string;
}): Promise<VisitorContact> {
  const normalizedPhone = normalizePhoneNumber(input.phone);
  const { data, error } = await supabaseAdmin
    .from("visitor_contacts")
    .upsert(
      {
        tenant_id: input.tenant_id,
        device_id: input.device_id,
        chat_id: input.chat_id ?? null,
        full_name: input.full_name.trim(),
        email: input.email.trim().toLowerCase(),
        phone_raw: input.phone.trim(),
        phone_normalized: normalizedPhone,
        captured_at: new Date().toISOString()
      },
      { onConflict: "tenant_id,device_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to save visitor contact: ${error?.message ?? "Unknown error"}`);
  }

  return data as VisitorContact;
}

export async function countAssistantMessagesForTenantDevice(
  tenantId: string,
  deviceId: string
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("messages")
    .select("id, chats!inner(tenant_id, device_id)", { head: true, count: "exact" })
    .eq("role", "assistant")
    .eq("chats.tenant_id", tenantId)
    .eq("chats.device_id", deviceId);

  if (error) {
    throw new HttpError(500, `Failed to count assistant messages: ${error.message}`);
  }

  return count ?? 0;
}

export async function countChatsForTenantDevice(
  tenantId: string,
  deviceId: string
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("chats")
    .select("id", { head: true, count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("device_id", deviceId);

  if (error) {
    throw new HttpError(500, `Failed to count chats: ${error.message}`);
  }

  return count ?? 0;
}

// ── Phase 1: Conversation Model Functions ──────────────────────────

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .eq("id", chatId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load chat: ${error.message}`);
  }

  return (data as ChatThread | null) ?? null;
}

export async function updateChatMode(
  chatId: string,
  updates: {
    conversation_mode: ConversationMode;
    conversation_status?: ConversationStatus;
    assigned_agent_id?: string | null;
    handoff_requested_at?: string | null;
    assigned_at?: string | null;
    closed_at?: string | null;
    queue_id?: string | null;
    workspace_id?: string | null;
    sla_started_at?: string | null;
    sla_first_response_due_at?: string | null;
    first_agent_response_at?: string | null;
    sla_warning_sent_at?: string | null;
    sla_breached?: boolean;
    sla_breached_at?: string | null;
    overflowed_at?: string | null;
    visitor_is_vip?: boolean;
    routing_skill?: string | null;
    archived_at?: string | null;
  }
): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("id", chatId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update chat mode: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatThread;
}

export async function updateChatFields(
  chatId: string,
  updates: {
    conversation_status?: ConversationStatus;
    assigned_agent_id?: string | null;
    assigned_at?: string | null;
    handoff_requested_at?: string | null;
    closed_at?: string | null;
    queue_id?: string | null;
    workspace_id?: string | null;
    sla_started_at?: string | null;
    sla_first_response_due_at?: string | null;
    first_agent_response_at?: string | null;
    sla_warning_sent_at?: string | null;
    sla_breached?: boolean;
    sla_breached_at?: string | null;
    overflowed_at?: string | null;
    visitor_is_vip?: boolean;
    routing_skill?: string | null;
    archived_at?: string | null;
  }
): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("id", chatId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update conversation: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatThread;
}

export async function listAgentConversations(
  agentUserId: string,
  tenantIds: string[]
): Promise<ChatThread[]> {
  if (tenantIds.length === 0) {
    return [];
  }

  // Fetch conversations assigned to this agent + unassigned handoff_pending conversations
  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .in("tenant_id", tenantIds)
    .or(`assigned_agent_id.eq.${agentUserId},and(conversation_mode.eq.handoff_pending,assigned_agent_id.is.null)`)
    .in("conversation_status", ["active", "waiting", "assigned"])
    .order("last_message_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new HttpError(500, `Failed to list agent conversations: ${error.message}`);
  }

  return (data ?? []) as ChatThread[];
}

export async function acceptConversationWithOptimisticLock(
  chatId: string,
  agentUserId: string
): Promise<ChatThread | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("chats")
    .update({
      conversation_mode: "agent_active",
      conversation_status: "assigned",
      assigned_agent_id: agentUserId,
      assigned_at: now,
      updated_at: now
    })
    .eq("id", chatId)
    .eq("conversation_mode", "handoff_pending")
    .or(`assigned_agent_id.is.null,assigned_agent_id.eq.${agentUserId}`)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to accept conversation: ${error.message}`);
  }

  return (data as ChatThread | null) ?? null;
}

export async function insertConversationEvent(input: {
  chat_id: string;
  event_type: string;
  actor_id?: string | null;
  actor_type?: string | null;
  old_mode?: ConversationMode | null;
  new_mode?: ConversationMode | null;
  metadata?: Record<string, unknown>;
}): Promise<ConversationEvent> {
  const { data, error } = await supabaseAdmin
    .from("conversation_events")
    .insert({
      chat_id: input.chat_id,
      event_type: input.event_type,
      actor_id: input.actor_id ?? null,
      actor_type: input.actor_type ?? null,
      old_mode: input.old_mode ?? null,
      new_mode: input.new_mode ?? null,
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to insert conversation event: ${error?.message ?? "Unknown error"}`);
  }

  return data as ConversationEvent;
}

export async function listPendingHandoffChatsForSla(limit = 300): Promise<ChatThread[]> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .in("conversation_mode", ["handoff_pending", "agent_active", "copilot"])
    .is("first_agent_response_at", null)
    .not("sla_first_response_due_at", "is", null)
    .order("sla_first_response_due_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new HttpError(500, `Failed to load pending SLA conversations: ${error.message}`);
  }

  return (data ?? []) as ChatThread[];
}

export async function getLatestUserMessage(chatId: string): Promise<ChatMessage | null> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load latest user message: ${error.message}`);
  }

  return (data as ChatMessage | null) ?? null;
}

export async function getConversationCsat(chatId: string): Promise<ConversationCsat | null> {
  const { data, error } = await supabaseAdmin
    .from("conversation_csat")
    .select("*")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load conversation CSAT: ${error.message}`);
  }

  return (data as ConversationCsat | null) ?? null;
}

export async function upsertConversationCsat(input: {
  chat_id: string;
  tenant_id: string;
  workspace_id?: string | null;
  rating: number;
  feedback?: string | null;
  submitted_by?: "visitor" | "agent" | "supervisor" | "system";
}): Promise<ConversationCsat> {
  const { data, error } = await supabaseAdmin
    .from("conversation_csat")
    .upsert(
      {
        chat_id: input.chat_id,
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id ?? null,
        rating: input.rating,
        feedback: input.feedback?.trim() || null,
        submitted_by: input.submitted_by ?? "visitor",
        submitted_at: new Date().toISOString()
      },
      { onConflict: "chat_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to save conversation CSAT: ${error?.message ?? "Unknown error"}`);
  }

  return data as ConversationCsat;
}

export async function archiveExpiredClosedChats(input: {
  tenantId: string;
  closedBefore: string;
  limit: number;
}): Promise<number> {
  const { data: candidates, error: candidateError } = await supabaseAdmin
    .from("chats")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("conversation_mode", "closed")
    .neq("conversation_status", "archived")
    .not("closed_at", "is", null)
    .lte("closed_at", input.closedBefore)
    .order("closed_at", { ascending: true })
    .limit(input.limit);

  if (candidateError) {
    throw new HttpError(500, `Failed to load archive candidates: ${candidateError.message}`);
  }

  const ids = ((candidates ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) {
    return 0;
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("chats")
    .update({
      conversation_status: "archived",
      archived_at: nowIso,
      updated_at: nowIso
    })
    .in("id", ids);

  if (updateError) {
    throw new HttpError(500, `Failed to archive closed chats: ${updateError.message}`);
  }

  return ids.length;
}

export async function deleteArchivedChats(input: {
  tenantId: string;
  archivedBefore: string;
  limit: number;
}): Promise<number> {
  const { data: candidates, error: candidateError } = await supabaseAdmin
    .from("chats")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("conversation_status", "archived")
    .not("closed_at", "is", null)
    .lte("closed_at", input.archivedBefore)
    .order("closed_at", { ascending: true })
    .limit(input.limit);

  if (candidateError) {
    throw new HttpError(500, `Failed to load purge candidates: ${candidateError.message}`);
  }

  const ids = ((candidates ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) {
    return 0;
  }

  const { error: deleteError } = await supabaseAdmin
    .from("chats")
    .delete()
    .in("id", ids);

  if (deleteError) {
    throw new HttpError(500, `Failed to delete archived chats: ${deleteError.message}`);
  }

  return ids.length;
}
