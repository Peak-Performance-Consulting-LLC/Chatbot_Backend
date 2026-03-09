import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import type { ChatMessage, ChatRole, ChatThread, MessageMetadata } from "@/chat/types";

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

export async function listRecentMessages(chatId: string, limit = 12): Promise<ChatMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

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
