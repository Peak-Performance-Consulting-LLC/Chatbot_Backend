import {
  getChatById,
  insertConversationEvent,
  insertChatMessage,
  listPendingHandoffChatsForSla,
  updateChatFields
} from "@/chat/repository";
import type { ChatThread } from "@/chat/types";
import {
  getQueueById,
  listWorkspaceSupervisors,
  touchQueueMemberLastAssigned,
  type QueueRecord
} from "@/agent/repository";
import { acceptConversation, getModeTransitionMessage } from "@/services/conversation";
import { findEligibleAgentForQueue, buildSlaTargetsForQueue } from "@/services/routing";
import {
  broadcastAgentNotification,
  broadcastMessage,
  broadcastModeChange,
  broadcastQueueConversation
} from "@/services/notification";

function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function getSlaAnchor(chat: ChatThread): Date | null {
  return (
    toDate(chat.sla_started_at) ||
    toDate(chat.handoff_requested_at) ||
    toDate(chat.updated_at) ||
    null
  );
}

async function notifyWorkspaceSupervisors(
  workspaceId: string,
  payload: Record<string, unknown>
) {
  const supervisors = await listWorkspaceSupervisors(workspaceId);
  await Promise.all(
    supervisors.map((supervisor) =>
      broadcastAgentNotification(supervisor.user_id, "inbox_update", payload)
    )
  );
}

async function tryAutoAssignFromQueue(input: {
  chatId: string;
  queue: QueueRecord;
  routingSkill?: string | null;
  visitorIsVip?: boolean;
}): Promise<boolean> {
  if (input.queue.routing_mode !== "auto_assign") {
    return false;
  }

  const eligible = await findEligibleAgentForQueue(input.queue.id, {
    requiredSkill: input.routingSkill,
    isVip: input.visitorIsVip,
    routingStrategy: input.queue.routing_strategy
  });
  if (!eligible) {
    return false;
  }

  const assigned = await acceptConversation(input.chatId, eligible.userId);
  await touchQueueMemberLastAssigned({
    queue_id: input.queue.id,
    user_id: eligible.userId
  }).catch(() => undefined);
  const joined = getModeTransitionMessage("agent_active", eligible.fullName);

  if (joined) {
    const systemMessage = await insertChatMessage({
      chat_id: input.chatId,
      role: "system",
      content: joined,
      sender_type: "system",
      metadata: {
        mode_change: "agent_active",
        agent_id: eligible.userId,
        agent_name: eligible.fullName,
        agent_avatar_url: eligible.avatarUrl
      }
    });
    await broadcastMessage(input.chatId, systemMessage);
  }

  await Promise.all([
    broadcastModeChange(input.chatId, "agent_active", {
      queue_id: input.queue.id,
      agent_id: eligible.userId,
      agent_name: eligible.fullName,
      agent_avatar_url: eligible.avatarUrl
    }),
    broadcastAgentNotification(eligible.userId, "assignment", {
      chat_id: input.chatId,
      mode: assigned.conversation_mode,
      queue_id: input.queue.id
    })
  ]);

  return true;
}

export async function recordFirstAgentResponse(chat: ChatThread): Promise<ChatThread> {
  if (chat.first_agent_response_at) {
    return chat;
  }

  return updateChatFields(chat.id, {
    first_agent_response_at: new Date().toISOString()
  });
}

export async function runSlaMaintenanceSweep(limit = 300): Promise<{
  scanned: number;
  warnings: number;
  breaches: number;
  overflowRerouted: number;
  autoAssigned: number;
}> {
  const now = new Date();
  const nowIso = now.toISOString();
  const conversations = await listPendingHandoffChatsForSla(limit);

  let warnings = 0;
  let breaches = 0;
  let overflowRerouted = 0;
  let autoAssigned = 0;

  const queueCache = new Map<string, QueueRecord | null>();

  for (const conversation of conversations) {
    if (!conversation.queue_id) {
      continue;
    }

    let queue: QueueRecord | null;
    if (queueCache.has(conversation.queue_id)) {
      queue = queueCache.get(conversation.queue_id) ?? null;
    } else {
      queue = await getQueueById(conversation.queue_id);
      queueCache.set(conversation.queue_id, queue);
    }
    if (!queue || !queue.is_active) {
      continue;
    }

    const dueAt = toDate(conversation.sla_first_response_due_at);
    if (!dueAt) {
      continue;
    }

    const warningAt = new Date(dueAt.getTime() - Math.max(0, queue.sla_warning_seconds) * 1000);
    const isWarningWindow = now >= warningAt && now < dueAt;
    const shouldWarn = !conversation.sla_warning_sent_at && isWarningWindow;

    if (shouldWarn) {
      await Promise.all([
        updateChatFields(conversation.id, {
          sla_warning_sent_at: nowIso
        }),
        insertConversationEvent({
          chat_id: conversation.id,
          event_type: "sla_warning",
          actor_id: null,
          actor_type: "system",
          old_mode: conversation.conversation_mode,
          new_mode: conversation.conversation_mode,
          metadata: {
            queue_id: conversation.queue_id,
            warning_at: nowIso,
            due_at: dueAt.toISOString()
          }
        })
      ]);

      await notifyWorkspaceSupervisors(conversation.workspace_id ?? conversation.tenant_id, {
        type: "sla_warning",
        chat_id: conversation.id,
        queue_id: conversation.queue_id,
        due_at: dueAt.toISOString()
      });
      warnings += 1;
    }

    if (now < dueAt || conversation.sla_breached) {
      continue;
    }

    await Promise.all([
      updateChatFields(conversation.id, {
        sla_breached: true,
        sla_breached_at: nowIso
      }),
      insertConversationEvent({
        chat_id: conversation.id,
        event_type: "sla_breached",
        actor_id: null,
        actor_type: "system",
        old_mode: conversation.conversation_mode,
        new_mode: conversation.conversation_mode,
        metadata: {
          queue_id: conversation.queue_id,
          due_at: dueAt.toISOString(),
          breached_at: nowIso
        }
      })
    ]);

    await notifyWorkspaceSupervisors(conversation.workspace_id ?? conversation.tenant_id, {
      type: "sla_breached",
      chat_id: conversation.id,
      queue_id: conversation.queue_id,
      due_at: dueAt.toISOString(),
      breached_at: nowIso
    });

    breaches += 1;

    if (
      conversation.conversation_mode !== "handoff_pending" ||
      !queue.overflow_queue_id ||
      conversation.overflowed_at
    ) {
      continue;
    }

    const anchor = getSlaAnchor(conversation);
    if (!anchor) {
      continue;
    }

    const elapsedSeconds = Math.floor((now.getTime() - anchor.getTime()) / 1000);
    if (elapsedSeconds < Math.max(0, queue.overflow_after_seconds)) {
      continue;
    }

    const overflowQueue = await getQueueById(queue.overflow_queue_id);
    if (!overflowQueue || !overflowQueue.is_active || overflowQueue.workspace_id !== queue.workspace_id) {
      continue;
    }

    const sla = buildSlaTargetsForQueue(overflowQueue, now);

    await Promise.all([
      updateChatFields(conversation.id, {
        queue_id: overflowQueue.id,
        overflowed_at: nowIso,
        sla_started_at: sla.sla_started_at,
        sla_first_response_due_at: sla.sla_first_response_due_at,
        sla_warning_sent_at: null,
        sla_breached: false,
        sla_breached_at: null
      }),
      insertConversationEvent({
        chat_id: conversation.id,
        event_type: "overflow_rerouted",
        actor_id: null,
        actor_type: "system",
        old_mode: conversation.conversation_mode,
        new_mode: conversation.conversation_mode,
        metadata: {
          from_queue_id: queue.id,
          to_queue_id: overflowQueue.id,
          rerouted_at: nowIso
        }
      })
    ]);

    await Promise.all([
      broadcastModeChange(conversation.id, "handoff_pending", {
        queue_id: overflowQueue.id,
        reason: "overflow"
      }),
      broadcastQueueConversation(overflowQueue.id, {
        chat_id: conversation.id,
        tenant_id: conversation.tenant_id,
        mode: "handoff_pending",
        queue_id: overflowQueue.id
      })
    ]);

    overflowRerouted += 1;

    const autoAssignedFromOverflow = await tryAutoAssignFromQueue({
      chatId: conversation.id,
      queue: overflowQueue,
      routingSkill: conversation.routing_skill,
      visitorIsVip: conversation.visitor_is_vip
    });

    if (autoAssignedFromOverflow) {
      autoAssigned += 1;
    }
  }

  return {
    scanned: conversations.length,
    warnings,
    breaches,
    overflowRerouted,
    autoAssigned
  };
}

export async function refreshConversationSlaOnQueue(input: {
  chatId: string;
  queue: QueueRecord;
  resetWarning: boolean;
}) {
  const conversation = await getChatById(input.chatId);
  if (!conversation) {
    return null;
  }

  const now = new Date();
  const sla = buildSlaTargetsForQueue(input.queue, now);

  return updateChatFields(conversation.id, {
    sla_started_at: sla.sla_started_at,
    sla_first_response_due_at: sla.sla_first_response_due_at,
    ...(input.resetWarning ? { sla_warning_sent_at: null } : {}),
    sla_breached: false,
    sla_breached_at: null
  });
}
