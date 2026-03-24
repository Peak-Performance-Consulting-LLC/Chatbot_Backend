import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import type { ChatMessage, ChatRole, ChatThread, MessageMetadata } from "@/chat/types";

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
      device_id: input.device_id,
      title: input.title ?? "New chat"
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
}): Promise<ChatMessage> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      chat_id: input.chat_id,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to save chat message: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatMessage;
}

export async function listChatMessages(chatId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

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
