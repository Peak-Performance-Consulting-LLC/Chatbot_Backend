import { HttpError } from "@/lib/httpError";
import { getQueueById } from "@/agent/repository";
import { getChatById, insertConversationEvent, updateChatMode } from "@/chat/repository";
import { buildSlaTargetsForQueue } from "@/services/routing";
import type { ChatThread } from "@/chat/types";

export async function transferConversationToAgent(input: {
  chatId: string;
  actorUserId: string;
  targetAgentUserId: string;
  targetQueueId?: string;
}): Promise<ChatThread> {
  const chat = await getChatById(input.chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }
  if (chat.conversation_mode === "closed") {
    throw new HttpError(400, "Conversation is closed");
  }

  const nextQueueId = input.targetQueueId ?? chat.queue_id ?? null;
  if (nextQueueId) {
    const queue = await getQueueById(nextQueueId);
    if (!queue) {
      throw new HttpError(404, "Target queue not found");
    }
    if (!queue.is_active) {
      throw new HttpError(400, "Target queue is inactive");
    }
  }

  const updated = await updateChatMode(chat.id, {
    conversation_mode: "agent_active",
    conversation_status: "assigned",
    assigned_agent_id: input.targetAgentUserId,
    assigned_at: new Date().toISOString(),
    handoff_requested_at: chat.handoff_requested_at,
    closed_at: null,
    queue_id: nextQueueId,
    workspace_id: chat.workspace_id ?? chat.tenant_id
  });

  await insertConversationEvent({
    chat_id: chat.id,
    event_type: "transferred_to_agent",
    actor_id: input.actorUserId,
    actor_type: "agent",
    old_mode: chat.conversation_mode,
    new_mode: updated.conversation_mode,
    metadata: {
      from_agent_id: chat.assigned_agent_id,
      to_agent_id: input.targetAgentUserId,
      to_queue_id: nextQueueId
    }
  }).catch(() => undefined);

  return updated;
}

export async function transferConversationToQueue(input: {
  chatId: string;
  actorUserId: string;
  targetQueueId: string;
}): Promise<ChatThread> {
  const chat = await getChatById(input.chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }
  if (chat.conversation_mode === "closed") {
    throw new HttpError(400, "Conversation is closed");
  }

  const queue = await getQueueById(input.targetQueueId);
  if (!queue) {
    throw new HttpError(404, "Target queue not found");
  }
  if (!queue.is_active) {
    throw new HttpError(400, "Target queue is inactive");
  }
  const slaTargets = buildSlaTargetsForQueue(queue, new Date());

  const updated = await updateChatMode(chat.id, {
    conversation_mode: "handoff_pending",
    conversation_status: "waiting",
    assigned_agent_id: null,
    assigned_at: null,
    handoff_requested_at: chat.handoff_requested_at ?? new Date().toISOString(),
    sla_started_at: slaTargets.sla_started_at,
    sla_first_response_due_at: slaTargets.sla_first_response_due_at,
    first_agent_response_at: null,
    sla_warning_sent_at: null,
    sla_breached: false,
    sla_breached_at: null,
    closed_at: null,
    queue_id: queue.id,
    workspace_id: chat.workspace_id ?? chat.tenant_id
  });

  await insertConversationEvent({
    chat_id: chat.id,
    event_type: "transferred_to_queue",
    actor_id: input.actorUserId,
    actor_type: "agent",
    old_mode: chat.conversation_mode,
    new_mode: updated.conversation_mode,
    metadata: {
      from_agent_id: chat.assigned_agent_id,
      to_queue_id: queue.id
    }
  }).catch(() => undefined);

  return updated;
}
