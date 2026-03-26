import { supabaseAdmin } from "@/lib/supabase";
import { logError, logInfo } from "@/lib/logger";
import { canBroadcastRealtimeEvent } from "@/lib/realtimeRateLimit";
import type { ChatMessage, ConversationMode } from "@/chat/types";

/**
 * Broadcasts a new message to the conversation's Supabase Realtime channel.
 * Widget and agent inbox subscribe to these channels for live updates.
 *
 * Channel: conversation:{chatId}
 * Event types: "new_message", "mode_change"
 */
export async function broadcastMessage(
  chatId: string,
  message: ChatMessage
): Promise<void> {
  try {
    await broadcastToChannel(`conversation:${chatId}`, "new_message", {
      id: message.id,
      chat_id: message.chat_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      sender_type: message.sender_type,
      sender_id: message.sender_id,
      is_internal: message.is_internal,
      is_draft: message.is_draft,
      created_at: message.created_at
    });

    logInfo("realtime_message_broadcast", {
      chat_id: chatId,
      message_id: message.id,
      sender_type: message.sender_type
    });
  } catch (error) {
    logError("realtime_message_broadcast_failed", {
      chat_id: chatId,
      message_id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Broadcasts a conversation mode change event.
 */
export async function broadcastModeChange(
  chatId: string,
  newMode: ConversationMode,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await broadcastToChannel(`conversation:${chatId}`, "mode_change", {
      chat_id: chatId,
      mode: newMode,
      ...metadata
    });

    logInfo("realtime_mode_change_broadcast", {
      chat_id: chatId,
      new_mode: newMode
    });
  } catch (error) {
    logError("realtime_mode_change_broadcast_failed", {
      chat_id: chatId,
      new_mode: newMode,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function broadcastToChannel(
  channelName: string,
  event: string,
  payload: Record<string, unknown>
) {
  const allowed = await canBroadcastRealtimeEvent({
    channel: channelName,
    event
  });
  if (!allowed) {
    logError("realtime_rate_limited", {
      channel: channelName,
      event
    });
    return;
  }

  const channel = supabaseAdmin.channel(channelName);
  try {
    await channel.send({
      type: "broadcast",
      event,
      payload
    });
  } finally {
    await supabaseAdmin.removeChannel(channel);
  }
}

export async function broadcastQueueConversation(
  queueId: string,
  payload: {
    chat_id: string;
    tenant_id: string;
    mode: ConversationMode;
    queue_id: string;
  }
): Promise<void> {
  try {
    await broadcastToChannel(`queue:${queueId}`, "new_conversation", payload);
    logInfo("realtime_queue_broadcast", {
      queue_id: queueId,
      chat_id: payload.chat_id,
      mode: payload.mode
    });
  } catch (error) {
    logError("realtime_queue_broadcast_failed", {
      queue_id: queueId,
      chat_id: payload.chat_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function broadcastAgentNotification(
  agentId: string,
  event: "assignment" | "presence" | "inbox_update",
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await broadcastToChannel(`agent:${agentId}`, event, payload);
    logInfo("realtime_agent_broadcast", {
      agent_id: agentId,
      event
    });
  } catch (error) {
    logError("realtime_agent_broadcast_failed", {
      agent_id: agentId,
      event,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function broadcastTypingIndicator(
  chatId: string,
  payload: {
    chat_id: string;
    actor: "agent" | "visitor";
    user_id: string;
    is_typing: boolean;
  }
): Promise<void> {
  try {
    await broadcastToChannel(`conversation:${chatId}`, "typing", payload);
  } catch (error) {
    logError("realtime_typing_broadcast_failed", {
      chat_id: chatId,
      actor: payload.actor,
      user_id: payload.user_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
