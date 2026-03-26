import { HttpError } from "@/lib/httpError";
import type { ChatThread } from "@/chat/types";
import { writeAuditLog } from "@/services/audit";
import {
  createQueue,
  getFirstActiveQueue,
  getFirstActiveVipQueue,
  getQueueById,
  getWorkspaceMemberByUser,
  listAgentLoadForQueues,
  listQueueConversations,
  listQueueIdsForUser,
  listQueueMembersWithAgent,
  listQueues,
  type QueueAfterHoursAction,
  type QueueRoutingMode,
  type QueueRoutingStrategy,
  upsertQueueMember,
  updateQueue,
  updateChatQueue
} from "@/agent/repository";

const MANAGE_QUEUE_ROLES = new Set(["owner", "admin", "supervisor"]);

function assertCanManageQueues(role: string) {
  if (!MANAGE_QUEUE_ROLES.has(role)) {
    throw new HttpError(403, "Only owners, admins, and supervisors can manage queues");
  }
}

export async function listWorkspaceQueues(input: {
  workspaceId: string;
  actorUserId: string;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }

  return listQueues(input.workspaceId);
}

export async function createWorkspaceQueue(input: {
  workspaceId: string;
  actorUserId: string;
  name: string;
  routingMode?: QueueRoutingMode;
  routingStrategy?: QueueRoutingStrategy;
  isVipQueue?: boolean;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }
  assertCanManageQueues(member.role);

  const queue = await createQueue({
    workspace_id: input.workspaceId,
    tenant_id: input.workspaceId,
    name: input.name,
    routing_mode: input.routingMode ?? "manual_accept",
    routing_strategy: input.routingStrategy ?? "priority_least_active",
    is_vip_queue: input.isVipQueue ?? false,
    created_by: input.actorUserId
  });
  await writeAuditLog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: "queue.created",
    targetType: "queue",
    targetId: queue.id,
    metadata: {
      routing_mode: queue.routing_mode,
      routing_strategy: queue.routing_strategy,
      is_vip_queue: queue.is_vip_queue
    }
  });

  return queue;
}

export async function updateWorkspaceQueue(input: {
  queueId: string;
  workspaceId: string;
  actorUserId: string;
  name?: string;
  routingMode?: QueueRoutingMode;
  routingStrategy?: QueueRoutingStrategy;
  isActive?: boolean;
  isVipQueue?: boolean;
  businessHours?: Record<string, unknown>;
  afterHoursAction?: QueueAfterHoursAction;
  overflowQueueId?: string | null;
  slaFirstResponseSeconds?: number;
  slaWarningSeconds?: number;
  overflowAfterSeconds?: number;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }
  assertCanManageQueues(actor.role);

  const queue = await getQueueById(input.queueId);
  if (!queue || queue.workspace_id !== input.workspaceId) {
    throw new HttpError(404, "Queue not found");
  }

  if (input.overflowQueueId) {
    if (input.overflowQueueId === input.queueId) {
      throw new HttpError(400, "A queue cannot overflow to itself");
    }
    const overflowQueue = await getQueueById(input.overflowQueueId);
    if (!overflowQueue || overflowQueue.workspace_id !== input.workspaceId) {
      throw new HttpError(400, "Overflow queue must belong to the same workspace");
    }
  }

  const updated = await updateQueue({
    queue_id: input.queueId,
    workspace_id: input.workspaceId,
    name: input.name,
    routing_mode: input.routingMode,
    routing_strategy: input.routingStrategy,
    is_active: input.isActive,
    is_vip_queue: input.isVipQueue,
    business_hours: input.businessHours,
    after_hours_action: input.afterHoursAction,
    overflow_queue_id: input.overflowQueueId,
    sla_first_response_seconds: input.slaFirstResponseSeconds,
    sla_warning_seconds: input.slaWarningSeconds,
    overflow_after_seconds: input.overflowAfterSeconds
  });

  await writeAuditLog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: "queue.updated",
    targetType: "queue",
    targetId: updated.id,
    metadata: {
      routing_mode: updated.routing_mode,
      routing_strategy: updated.routing_strategy,
      is_vip_queue: updated.is_vip_queue,
      after_hours_action: updated.after_hours_action,
      overflow_queue_id: updated.overflow_queue_id,
      sla_first_response_seconds: updated.sla_first_response_seconds,
      sla_warning_seconds: updated.sla_warning_seconds,
      overflow_after_seconds: updated.overflow_after_seconds
    }
  });

  return updated;
}

export async function addAgentToQueue(input: {
  queueId: string;
  workspaceId: string;
  actorUserId: string;
  memberUserId: string;
  priority?: number;
  maxConcurrentChats?: number;
  skills?: string[];
  handlesVip?: boolean;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }
  assertCanManageQueues(actor.role);

  const queue = await getQueueById(input.queueId);
  if (!queue || queue.workspace_id !== input.workspaceId) {
    throw new HttpError(404, "Queue not found");
  }

  const targetMember = await getWorkspaceMemberByUser(input.workspaceId, input.memberUserId);
  if (!targetMember || !targetMember.is_active) {
    throw new HttpError(404, "Target user is not an active workspace member");
  }

  const queueMember = await upsertQueueMember({
    queue_id: queue.id,
    workspace_member_id: targetMember.id,
    priority: typeof input.priority === "number" ? Math.max(0, input.priority) : 100,
    max_concurrent_chats: typeof input.maxConcurrentChats === "number" ? Math.max(1, input.maxConcurrentChats) : 4,
    skills: input.skills?.map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [],
    handles_vip: input.handlesVip ?? true
  });
  await writeAuditLog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: "queue.member_upserted",
    targetType: "queue_member",
    targetId: queueMember.id,
    metadata: {
      queue_id: queue.id,
      user_id: input.memberUserId,
      priority: queueMember.priority,
      max_concurrent_chats: queueMember.max_concurrent_chats,
      skills: queueMember.skills,
      handles_vip: queueMember.handles_vip
    }
  });

  return queueMember;
}

export async function listQueueAgents(input: {
  queueId: string;
  workspaceId: string;
  actorUserId: string;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }

  const queue = await getQueueById(input.queueId);
  if (!queue || queue.workspace_id !== input.workspaceId) {
    throw new HttpError(404, "Queue not found");
  }

  return listQueueMembersWithAgent(input.queueId);
}

export async function getUserQueueIds(input: {
  workspaceId: string;
  userId: string;
}) {
  return listQueueIdsForUser(input.workspaceId, input.userId);
}

export async function listSupervisorQueueConversations(input: {
  workspaceId: string;
  actorUserId: string;
  includeClosed?: boolean;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }

  const queueIds = await listQueueIdsForUser(input.workspaceId, input.actorUserId);
  if (queueIds.length === 0 && member.role === "supervisor") {
    return [];
  }

  const targetQueueIds =
    queueIds.length > 0 ? queueIds : (await listQueues(input.workspaceId)).map((queue) => queue.id);

  return listQueueConversations({
    workspace_id: input.workspaceId,
    queue_ids: targetQueueIds,
    include_closed: input.includeClosed ?? false,
    limit: 400
  });
}

export async function listSupervisorAgentLoad(input: {
  workspaceId: string;
  actorUserId: string;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }

  const queueIds = await listQueueIdsForUser(input.workspaceId, input.actorUserId);
  if (queueIds.length === 0 && member.role === "supervisor") {
    return [];
  }
  const targetQueueIds =
    queueIds.length > 0 ? queueIds : (await listQueues(input.workspaceId)).map((queue) => queue.id);

  return listAgentLoadForQueues({
    workspace_id: input.workspaceId,
    queue_ids: targetQueueIds
  });
}

export async function resolveConversationQueue(chat: ChatThread): Promise<{
  queueId: string | null;
  workspaceId: string;
}> {
  const workspaceId = chat.workspace_id ?? chat.tenant_id;

  if (chat.visitor_is_vip) {
    const vipQueue = await getFirstActiveVipQueue(workspaceId);
    if (vipQueue) {
      await updateChatQueue({
        chat_id: chat.id,
        workspace_id: workspaceId,
        queue_id: vipQueue.id
      });
      return { queueId: vipQueue.id, workspaceId };
    }
  }

  if (chat.queue_id) {
    const existingQueue = await getQueueById(chat.queue_id);
    if (existingQueue && existingQueue.is_active) {
      if (!chat.workspace_id || chat.workspace_id !== workspaceId) {
        await updateChatQueue({
          chat_id: chat.id,
          workspace_id: workspaceId,
          queue_id: chat.queue_id
        });
      }
      return { queueId: chat.queue_id, workspaceId };
    }
  }

  const fallbackQueue = await getFirstActiveQueue(workspaceId);
  if (!fallbackQueue) {
    await updateChatQueue({
      chat_id: chat.id,
      workspace_id: workspaceId,
      queue_id: null
    });
    return { queueId: null, workspaceId };
  }

  await updateChatQueue({
    chat_id: chat.id,
    workspace_id: workspaceId,
    queue_id: fallbackQueue.id
  });

  return { queueId: fallbackQueue.id, workspaceId };
}
