import {
  getChatById,
  insertConversationEvent,
  insertChatMessage,
  listPendingHandoffChatsForSla,
  listVisitorInactiveChatsForMaintenance,
  touchChatThread,
  updateChatFields
} from "@/chat/repository";
import type { ChatThread } from "@/chat/types";
import {
  getQueueById,
  listWorkspaceNotificationRecipients,
  touchQueueMemberLastAssigned,
  type QueueRecord
} from "@/agent/repository";
import { acceptConversation, closeConversation, getModeTransitionMessage } from "@/services/conversation";
import { findEligibleAgentForQueue, buildSlaTargetsForQueue } from "@/services/routing";
import {
  broadcastAgentNotification,
  broadcastMessage,
  broadcastModeChange,
  broadcastQueueConversation,
  broadcastWorkspaceInboxUpdate
} from "@/services/notification";

const VISITOR_INACTIVITY_WARNING_MS = 5 * 60 * 1000;
const VISITOR_INACTIVITY_CLOSE_GRACE_MS = 5 * 60 * 1000;
const VISITOR_INACTIVITY_WARNING_MESSAGE =
  "Due to inactivity, this conversation will be marked as closed in 5 minutes. Please send a message if you still need help.";
const VISITOR_INACTIVITY_CLOSED_MESSAGE =
  "This conversation has been closed due to inactivity. You can start a new chat anytime if you need more help.";

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

async function notifyWorkspaceNotificationRecipients(
  workspaceId: string,
  payload: Record<string, unknown>
) {
  const recipients = await listWorkspaceNotificationRecipients(workspaceId);
  await Promise.all(
    recipients.map((recipient) =>
      broadcastAgentNotification(recipient.user_id, "inbox_update", payload)
    )
  );
}

function getVisitorInactivityAnchor(conversation: ChatThread): Date | null {
  return (
    toDate(conversation.last_external_message_at) ||
    toDate(conversation.last_visitor_message_at) ||
    toDate(conversation.last_visitor_activity_at) ||
    toDate(conversation.handoff_requested_at) ||
    toDate(conversation.updated_at)
  );
}

function hasExternalActivityAfterWarning(conversation: ChatThread): boolean {
  const warningSentAt = toDate(conversation.visitor_inactivity_warning_sent_at);
  const lastExternalAt = toDate(conversation.last_external_message_at);
  return Boolean(warningSentAt && lastExternalAt && lastExternalAt > warningSentAt);
}

function getVisitorInactivityAgeMs(conversation: ChatThread, now: Date): number | null {
  const anchor = getVisitorInactivityAnchor(conversation);
  if (!anchor) {
    return null;
  }
  return Math.max(0, now.getTime() - anchor.getTime());
}

function isVisitorInactivityWarningDue(conversation: ChatThread, now: Date): boolean {
  if (conversation.visitor_inactivity_warning_sent_at) {
    return false;
  }
  const ageMs = getVisitorInactivityAgeMs(conversation, now);
  return ageMs !== null && ageMs >= VISITOR_INACTIVITY_WARNING_MS;
}

function isVisitorInactivityCloseDue(conversation: ChatThread, now: Date): boolean {
  if (hasExternalActivityAfterWarning(conversation)) {
    return false;
  }

  const warnedAt = toDate(conversation.visitor_inactivity_warning_sent_at);
  const storedCloseDueAt = toDate(conversation.visitor_inactivity_close_due_at);
  const minimumCloseDueAt = warnedAt
    ? new Date(warnedAt.getTime() + VISITOR_INACTIVITY_CLOSE_GRACE_MS)
    : null;
  const closeDueAt =
    storedCloseDueAt && minimumCloseDueAt
      ? new Date(Math.max(storedCloseDueAt.getTime(), minimumCloseDueAt.getTime()))
      : storedCloseDueAt ?? minimumCloseDueAt;

  return Boolean(closeDueAt && now >= closeDueAt);
}

async function warnVisitorAboutInactivity(conversation: ChatThread, now: Date) {
  const warnedAt = now.toISOString();
  const closeDueAt = new Date(now.getTime() + VISITOR_INACTIVITY_CLOSE_GRACE_MS).toISOString();
  const message = await insertChatMessage({
    chat_id: conversation.id,
    role: "system",
    content: VISITOR_INACTIVITY_WARNING_MESSAGE,
    sender_type: "system",
    metadata: {
      visitor_inactivity_warning: true,
      close_due_at: closeDueAt
    }
  });

  await Promise.all([
    updateChatFields(conversation.id, {
      visitor_inactivity_warning_sent_at: warnedAt,
      visitor_inactivity_close_due_at: closeDueAt
    }),
    touchChatThread(conversation.id)
  ]);

  await Promise.all([
    broadcastMessage(conversation.id, message),
    broadcastWorkspaceInboxUpdate(conversation.workspace_id ?? conversation.tenant_id, {
      chat_id: conversation.id,
      tenant_id: conversation.tenant_id,
      queue_id: conversation.queue_id ?? null,
      mode: conversation.conversation_mode,
      reason: "visitor_inactivity_warning",
      visitor_inactivity_close_due_at: closeDueAt
    })
  ]);
}

async function closeVisitorInactiveConversation(conversation: ChatThread) {
  const closeMessage = await insertChatMessage({
    chat_id: conversation.id,
    role: "system",
    content: VISITOR_INACTIVITY_CLOSED_MESSAGE,
    sender_type: "system",
    metadata: {
      visitor_inactivity_auto_close: true
    }
  });
  await touchChatThread(conversation.id);
  await broadcastMessage(conversation.id, closeMessage);

  const updated = await closeConversation(conversation.id, undefined, "system");
  await Promise.all([
    broadcastModeChange(conversation.id, "closed", {
      closed_at: updated.closed_at,
      reason: "visitor_inactivity"
    }),
    broadcastWorkspaceInboxUpdate(conversation.workspace_id ?? conversation.tenant_id, {
      chat_id: conversation.id,
      tenant_id: conversation.tenant_id,
      queue_id: conversation.queue_id ?? null,
      mode: "closed",
      reason: "visitor_inactivity_closed",
      closed_at: updated.closed_at
    })
  ]);
}

async function processVisitorInactivity(input: {
  now: Date;
  limit: number;
  workspaceIds?: string[];
}): Promise<{
  warnings: number;
  closures: number;
}> {
  const olderThan = new Date(input.now.getTime() - VISITOR_INACTIVITY_WARNING_MS).toISOString();
  const conversations = await listVisitorInactiveChatsForMaintenance({
    olderThan,
    dueBefore: input.now.toISOString(),
    workspaceIds: input.workspaceIds,
    limit: input.limit
  });
  let warnings = 0;
  let closures = 0;

  for (const candidate of conversations) {
    const latest = await getChatById(candidate.id);
    if (
      !latest ||
      latest.conversation_mode === "closed" ||
      latest.conversation_status === "closed" ||
      latest.last_external_sender_type !== "agent"
    ) {
      continue;
    }

    if (isVisitorInactivityCloseDue(latest, input.now)) {
      await closeVisitorInactiveConversation(latest);
      closures += 1;
      continue;
    }

    if (isVisitorInactivityWarningDue(latest, input.now)) {
      await warnVisitorAboutInactivity(latest, input.now);
      warnings += 1;
    }
  }

  return { warnings, closures };
}

export async function runVisitorInactivityMaintenance(input?: {
  workspaceIds?: string[];
  limit?: number;
}): Promise<{
  warnings: number;
  closures: number;
}> {
  return processVisitorInactivity({
    now: new Date(),
    limit: input?.limit ?? 300,
    workspaceIds: input?.workspaceIds
  });
}

async function tryAutoAssignFromQueue(input: {
  conversation: ChatThread;
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

  const assigned = await acceptConversation(input.conversation.id, eligible.userId);
  await touchQueueMemberLastAssigned({
    queue_id: input.queue.id,
    user_id: eligible.userId
  }).catch(() => undefined);
  const joined = getModeTransitionMessage("agent_active", eligible.fullName);

  if (joined) {
    const systemMessage = await insertChatMessage({
      chat_id: input.conversation.id,
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
    await broadcastMessage(input.conversation.id, systemMessage);
  }

  await Promise.all([
    broadcastModeChange(input.conversation.id, "agent_active", {
      queue_id: input.queue.id,
      agent_id: eligible.userId,
      agent_name: eligible.fullName,
      agent_avatar_url: eligible.avatarUrl
    }),
    broadcastAgentNotification(eligible.userId, "assignment", {
      chat_id: input.conversation.id,
      mode: assigned.conversation_mode,
      queue_id: input.queue.id
    }),
    broadcastWorkspaceInboxUpdate(
      input.conversation.workspace_id ?? input.conversation.tenant_id,
      {
        chat_id: input.conversation.id,
        tenant_id: input.conversation.tenant_id,
        queue_id: input.queue.id,
        mode: "agent_active",
        reason: "conversation_assigned",
        awaiting_agent_reply: false,
        waiting_age_seconds: null,
        waiting_urgency: null
      }
    )
  ]);

  return true;
}

function shouldTryAutoAssign(conversation: ChatThread): boolean {
  return (
    conversation.conversation_mode === "handoff_pending" &&
    !conversation.assigned_agent_id
  );
}

async function tryOpportunisticAutoAssign(input: {
  conversation: ChatThread;
  queue: QueueRecord;
}): Promise<boolean> {
  if (!shouldTryAutoAssign(input.conversation)) {
    return false;
  }
  return tryAutoAssignFromQueue({
    conversation: input.conversation,
    queue: input.queue,
    routingSkill: input.conversation.routing_skill,
    visitorIsVip: input.conversation.visitor_is_vip
  });
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
  inactivityWarnings: number;
  inactivityClosures: number;
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

    const autoAssignedFromPending = await tryOpportunisticAutoAssign({
      conversation,
      queue
    });
    if (autoAssignedFromPending) {
      autoAssigned += 1;
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

      await notifyWorkspaceNotificationRecipients(conversation.workspace_id ?? conversation.tenant_id, {
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

    await notifyWorkspaceNotificationRecipients(conversation.workspace_id ?? conversation.tenant_id, {
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
      }),
      broadcastWorkspaceInboxUpdate(conversation.workspace_id ?? conversation.tenant_id, {
        chat_id: conversation.id,
        tenant_id: conversation.tenant_id,
        queue_id: overflowQueue.id,
        mode: "handoff_pending",
        reason: "conversation_queued",
        awaiting_agent_reply: true,
        waiting_age_seconds: 0,
        waiting_urgency: "normal"
      })
    ]);

    overflowRerouted += 1;

    const autoAssignedFromOverflow = await tryAutoAssignFromQueue({
      conversation,
      queue: overflowQueue,
      routingSkill: conversation.routing_skill,
      visitorIsVip: conversation.visitor_is_vip
    });

    if (autoAssignedFromOverflow) {
      autoAssigned += 1;
    }
  }

  const inactivity = await processVisitorInactivity({
    now,
    limit
  });

  return {
    scanned: conversations.length,
    warnings,
    breaches,
    overflowRerouted,
    autoAssigned,
    inactivityWarnings: inactivity.warnings,
    inactivityClosures: inactivity.closures
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
