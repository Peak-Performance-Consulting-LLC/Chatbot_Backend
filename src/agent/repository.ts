import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import type { ChatThread, ConversationMode, VisitorState, WaitingUrgency } from "@/chat/types";

export type WorkspaceMemberRole = "owner" | "admin" | "supervisor" | "agent" | "viewer";
export type AgentPresenceStatus = "online" | "away" | "offline";
export type AgentEffectiveStatus = "online" | "busy" | "away" | "offline";
export type QueueRoutingMode = "manual_accept" | "auto_assign";
export type QueueAfterHoursAction = "collect_info" | "overflow" | "ai_only";
export type QueueRoutingStrategy = "priority_least_active" | "round_robin";

export type WorkspaceMemberRecord = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceMemberRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type QueueRecord = {
  id: string;
  workspace_id: string;
  tenant_id: string;
  name: string;
  routing_mode: QueueRoutingMode;
  is_active: boolean;
  business_hours: Record<string, unknown>;
  after_hours_action: QueueAfterHoursAction;
  routing_strategy: QueueRoutingStrategy;
  is_vip_queue: boolean;
  sla_first_response_seconds: number;
  sla_warning_seconds: number;
  overflow_after_seconds: number;
  overflow_queue_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type QueueMemberRecord = {
  id: string;
  queue_id: string;
  workspace_member_id: string;
  priority: number;
  max_concurrent_chats: number;
  skills: string[];
  handles_vip: boolean;
  last_assigned_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentPresenceRecord = {
  workspace_member_id: string;
  status: AgentPresenceStatus;
  last_heartbeat_at: string | null;
};

type VisitorContactSnapshot = {
  tenant_id: string;
  device_id: string;
  full_name: string;
  email: string;
  phone_raw: string;
};

export type AgentInboxPayload = {
  conversations: ChatThread[];
  my_active: ChatThread[];
  queue_unassigned: ChatThread[];
  waiting_count: number;
  answered_count: number;
  high_waiting_count: number;
  critical_waiting_count: number;
};

type WorkspaceMemberWithUserRow = WorkspaceMemberRecord & {
  platform_user: {
    id: string;
    email: string;
    full_name: string;
    avatar_url: string | null;
  } | null;
};

type QueueMemberWithAgentRow = QueueMemberRecord & {
  workspace_member: WorkspaceMemberWithUserRow | null;
};

function takeFirst<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

const WAITING_WARNING_SECONDS = 2 * 60;
const WAITING_HIGH_SECONDS = 5 * 60;
const WAITING_CRITICAL_SECONDS = 15 * 60;

const VISITOR_TYPING_WINDOW_MS = 8_000;
const VISITOR_ACTIVE_WINDOW_MS = 2 * 60 * 1_000;
const VISITOR_IDLE_WINDOW_MS = 15 * 60 * 1_000;

function toUnixMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export async function getWorkspaceMemberByUser(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load workspace member: ${error.message}`);
  }

  return (data as WorkspaceMemberRecord | null) ?? null;
}

export async function listWorkspaceMembersWithUser(workspaceId: string): Promise<WorkspaceMemberWithUserRow[]> {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .select(
      "id, workspace_id, user_id, role, is_active, created_at, updated_at, platform_user:platform_users!workspace_members_user_id_fkey(id, email, full_name, avatar_url)"
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new HttpError(500, `Failed to list workspace members: ${error.message}`);
  }

  const rows = (data ?? []) as Array<
    WorkspaceMemberRecord & {
      platform_user:
        | { id: string; email: string; full_name: string; avatar_url: string | null }
        | Array<{ id: string; email: string; full_name: string; avatar_url: string | null }>
        | null;
    }
  >;

  return rows.map((row) => ({
    ...row,
    platform_user: takeFirst(row.platform_user)
  }));
}

export async function findPlatformUserByEmail(email: string): Promise<{
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
} | null> {
  const normalized = email.trim().toLowerCase();
  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .select("id, email, full_name, avatar_url")
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to lookup platform user: ${error.message}`);
  }

  return (data as { id: string; email: string; full_name: string; avatar_url: string | null } | null) ?? null;
}

export async function upsertWorkspaceMember(input: {
  workspace_id: string;
  user_id: string;
  role: WorkspaceMemberRole;
  created_by?: string;
}): Promise<WorkspaceMemberRecord> {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .upsert(
      {
        workspace_id: input.workspace_id,
        user_id: input.user_id,
        role: input.role,
        is_active: true,
        created_by: input.created_by ?? null
      },
      { onConflict: "workspace_id,user_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to upsert workspace member: ${error?.message ?? "Unknown error"}`);
  }

  return data as WorkspaceMemberRecord;
}

export async function listQueues(workspaceId: string): Promise<QueueRecord[]> {
  const { data, error } = await supabaseAdmin
    .from("queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new HttpError(500, `Failed to list queues: ${error.message}`);
  }

  return (data ?? []) as QueueRecord[];
}

export async function getQueueById(queueId: string): Promise<QueueRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("queues")
    .select("*")
    .eq("id", queueId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load queue: ${error.message}`);
  }

  return (data as QueueRecord | null) ?? null;
}

export async function getFirstActiveQueue(workspaceId: string): Promise<QueueRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load active queue: ${error.message}`);
  }

  return (data as QueueRecord | null) ?? null;
}

export async function getFirstActiveVipQueue(workspaceId: string): Promise<QueueRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .eq("is_vip_queue", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load active VIP queue: ${error.message}`);
  }

  return (data as QueueRecord | null) ?? null;
}

export async function createQueue(input: {
  workspace_id: string;
  tenant_id: string;
  name: string;
  routing_mode?: QueueRoutingMode;
  routing_strategy?: QueueRoutingStrategy;
  is_vip_queue?: boolean;
  created_by?: string;
}): Promise<QueueRecord> {
  const { data, error } = await supabaseAdmin
    .from("queues")
    .insert({
      workspace_id: input.workspace_id,
      tenant_id: input.tenant_id,
      name: input.name.trim(),
      routing_mode: input.routing_mode ?? "manual_accept",
      routing_strategy: input.routing_strategy ?? "priority_least_active",
      is_vip_queue: input.is_vip_queue ?? false,
      created_by: input.created_by ?? null
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to create queue: ${error?.message ?? "Unknown error"}`);
  }

  return data as QueueRecord;
}

export async function updateQueue(input: {
  queue_id: string;
  workspace_id: string;
  name?: string;
  routing_mode?: QueueRoutingMode;
  routing_strategy?: QueueRoutingStrategy;
  is_active?: boolean;
  is_vip_queue?: boolean;
  business_hours?: Record<string, unknown>;
  after_hours_action?: QueueAfterHoursAction;
  overflow_queue_id?: string | null;
  sla_first_response_seconds?: number;
  sla_warning_seconds?: number;
  overflow_after_seconds?: number;
}): Promise<QueueRecord> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (typeof input.name === "string") {
    payload.name = input.name.trim();
  }
  if (input.routing_mode) {
    payload.routing_mode = input.routing_mode;
  }
  if (input.routing_strategy) {
    payload.routing_strategy = input.routing_strategy;
  }
  if (typeof input.is_active === "boolean") {
    payload.is_active = input.is_active;
  }
  if (typeof input.is_vip_queue === "boolean") {
    payload.is_vip_queue = input.is_vip_queue;
  }
  if (input.business_hours) {
    payload.business_hours = input.business_hours;
  }
  if (input.after_hours_action) {
    payload.after_hours_action = input.after_hours_action;
  }
  if (input.overflow_queue_id !== undefined) {
    payload.overflow_queue_id = input.overflow_queue_id;
  }
  if (typeof input.sla_first_response_seconds === "number") {
    payload.sla_first_response_seconds = input.sla_first_response_seconds;
  }
  if (typeof input.sla_warning_seconds === "number") {
    payload.sla_warning_seconds = input.sla_warning_seconds;
  }
  if (typeof input.overflow_after_seconds === "number") {
    payload.overflow_after_seconds = input.overflow_after_seconds;
  }

  const { data, error } = await supabaseAdmin
    .from("queues")
    .update(payload)
    .eq("id", input.queue_id)
    .eq("workspace_id", input.workspace_id)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update queue: ${error?.message ?? "Unknown error"}`);
  }

  return data as QueueRecord;
}

export async function upsertQueueMember(input: {
  queue_id: string;
  workspace_member_id: string;
  priority?: number;
  max_concurrent_chats?: number;
  skills?: string[];
  handles_vip?: boolean;
}): Promise<QueueMemberRecord> {
  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .upsert(
      {
        queue_id: input.queue_id,
        workspace_member_id: input.workspace_member_id,
        priority: input.priority ?? 100,
        max_concurrent_chats: input.max_concurrent_chats ?? 4,
        skills: input.skills ?? [],
        handles_vip: input.handles_vip ?? true,
        is_active: true
      },
      { onConflict: "queue_id,workspace_member_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update queue member: ${error?.message ?? "Unknown error"}`);
  }

  return data as QueueMemberRecord;
}

export async function listQueueMembersWithAgent(queueId: string): Promise<QueueMemberWithAgentRow[]> {
  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .select(
      "id, queue_id, workspace_member_id, priority, max_concurrent_chats, skills, handles_vip, last_assigned_at, is_active, created_at, updated_at, workspace_member:workspace_members!queue_members_workspace_member_id_fkey(id, workspace_id, user_id, role, is_active, created_at, updated_at, platform_user:platform_users!workspace_members_user_id_fkey(id, email, full_name, avatar_url))"
    )
    .eq("queue_id", queueId)
    .eq("is_active", true)
    .order("priority", { ascending: true });

  if (error) {
    throw new HttpError(500, `Failed to list queue members: ${error.message}`);
  }

  const rows = (data ?? []) as Array<
    QueueMemberRecord & {
      workspace_member:
        | (WorkspaceMemberRecord & {
            platform_user:
              | { id: string; email: string; full_name: string; avatar_url: string | null }
              | Array<{ id: string; email: string; full_name: string; avatar_url: string | null }>
              | null;
          })
        | Array<
            WorkspaceMemberRecord & {
              platform_user:
                | { id: string; email: string; full_name: string; avatar_url: string | null }
                | Array<{ id: string; email: string; full_name: string; avatar_url: string | null }>
                | null;
            }
          >
        | null;
    }
  >;

  return rows.map((row) => {
    const workspaceMember = takeFirst(row.workspace_member);
    if (!workspaceMember) {
      return {
        ...row,
        workspace_member: null
      };
    }

    return {
      ...row,
      workspace_member: {
        ...workspaceMember,
        platform_user: takeFirst(workspaceMember.platform_user)
      }
    };
  });
}

export async function listPresenceForWorkspaceMembers(
  workspaceMemberIds: string[]
): Promise<AgentPresenceRecord[]> {
  if (workspaceMemberIds.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("agent_presence")
    .select("workspace_member_id, status, last_heartbeat_at")
    .in("workspace_member_id", workspaceMemberIds);

  if (error) {
    throw new HttpError(500, `Failed to load presence records: ${error.message}`);
  }

  return (data ?? []) as AgentPresenceRecord[];
}

export async function countActiveChatsByAgent(userId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("chats")
    .select("id", { head: true, count: "exact" })
    .eq("assigned_agent_id", userId)
    .in("conversation_mode", ["agent_active", "copilot"]);

  if (error) {
    throw new HttpError(500, `Failed to count active chats for agent: ${error.message}`);
  }

  return count ?? 0;
}

export async function listActiveChatsByAgent(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("chats")
    .select("assigned_agent_id")
    .in("assigned_agent_id", uniqueUserIds)
    .in("conversation_mode", ["agent_active", "copilot"]);

  if (error) {
    throw new HttpError(500, `Failed to load active chat counts for agents: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ assigned_agent_id: string | null }>) {
    const userId = row.assigned_agent_id?.trim();
    if (!userId) continue;
    counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return counts;
}

export async function listWorkspaceMemberCapacityLimits(workspaceMemberIds: string[]): Promise<Map<string, number>> {
  if (workspaceMemberIds.length === 0) {
    return new Map();
  }

  const uniqueMemberIds = Array.from(new Set(workspaceMemberIds.filter(Boolean)));
  if (uniqueMemberIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .select("workspace_member_id, max_concurrent_chats")
    .in("workspace_member_id", uniqueMemberIds)
    .eq("is_active", true);

  if (error) {
    throw new HttpError(500, `Failed to load capacity limits: ${error.message}`);
  }

  const limits = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ workspace_member_id: string; max_concurrent_chats: number }>) {
    const memberId = row.workspace_member_id;
    const current = limits.get(memberId) ?? 0;
    const next = Number.isFinite(row.max_concurrent_chats) ? Math.max(1, row.max_concurrent_chats) : current;
    if (next > current) {
      limits.set(memberId, next);
    }
  }

  return limits;
}

export async function listQueueIdsForUser(workspaceId: string, userId: string): Promise<string[]> {
  const membership = await getWorkspaceMemberByUser(workspaceId, userId);
  if (!membership) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .select("queue_id, queues!inner(id, is_active)")
    .eq("workspace_member_id", membership.id)
    .eq("is_active", true);

  if (error) {
    throw new HttpError(500, `Failed to load user queue memberships: ${error.message}`);
  }

  return ((data ?? []) as Array<{ queue_id: string; queues?: { id?: string; is_active?: boolean } | null }>)
    .filter((row) => row.queues?.is_active !== false)
    .map((row) => row.queue_id)
    .filter(Boolean);
}

export async function isUserMemberOfQueue(queueId: string, userId: string): Promise<boolean> {
  const queue = await getQueueById(queueId);
  if (!queue) {
    return false;
  }

  const member = await getWorkspaceMemberByUser(queue.workspace_id, userId);
  if (!member) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .select("id")
    .eq("queue_id", queueId)
    .eq("workspace_member_id", member.id)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to verify queue membership: ${error.message}`);
  }

  return Boolean(data?.id);
}

export async function updateChatQueue(input: {
  chat_id: string;
  workspace_id: string;
  queue_id: string | null;
}): Promise<ChatThread> {
  const { data, error } = await supabaseAdmin
    .from("chats")
    .update({
      workspace_id: input.workspace_id,
      queue_id: input.queue_id,
      updated_at: new Date().toISOString()
    })
    .eq("id", input.chat_id)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update chat queue: ${error?.message ?? "Unknown error"}`);
  }

  return data as ChatThread;
}

function isMissingSharedInboxColumnError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) {
    return false;
  }
  const message = (error.message ?? "").toLowerCase();
  const referencesSharedInboxColumns =
    message.includes("awaiting_agent_reply") ||
    message.includes("last_external_sender_type") ||
    message.includes("last_external_message_at");

  if (!referencesSharedInboxColumns) {
    return false;
  }

  return error.code === "42703" || message.includes("does not exist");
}

function isConversationWaitingForAgent(conversation: ChatThread): boolean {
  const waitingFlag = (conversation as Partial<ChatThread>).awaiting_agent_reply;
  if (typeof waitingFlag === "boolean") {
    return waitingFlag;
  }
  return conversation.conversation_mode === "handoff_pending";
}

function deriveWaitingAgeSeconds(conversation: ChatThread, nowMs: number): number | null {
  if (!isConversationWaitingForAgent(conversation)) {
    return null;
  }
  const sourceTs =
    toUnixMs(conversation.last_external_message_at) ??
    toUnixMs(conversation.last_message_at);
  if (sourceTs === null) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - sourceTs) / 1000));
}

function deriveWaitingUrgency(waitingAgeSeconds: number | null): WaitingUrgency {
  if (waitingAgeSeconds === null || waitingAgeSeconds < WAITING_WARNING_SECONDS) {
    return "normal";
  }
  if (waitingAgeSeconds < WAITING_HIGH_SECONDS) {
    return "warning";
  }
  if (waitingAgeSeconds < WAITING_CRITICAL_SECONDS) {
    return "high";
  }
  return "critical";
}

function waitingUrgencyRank(urgency: WaitingUrgency | null | undefined): number {
  switch (urgency) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "warning":
      return 1;
    default:
      return 0;
  }
}

function deriveVisitorState(conversation: ChatThread, nowMs: number): VisitorState {
  const typingTs = toUnixMs(conversation.last_visitor_typing_at);
  if (typingTs !== null && nowMs - typingTs <= VISITOR_TYPING_WINDOW_MS) {
    return "typing";
  }

  const activityTs =
    toUnixMs(conversation.last_visitor_activity_at) ??
    toUnixMs(conversation.last_visitor_message_at);
  if (activityTs === null) {
    return "away";
  }

  const delta = nowMs - activityTs;
  if (delta <= VISITOR_ACTIVE_WINDOW_MS) {
    return "active";
  }
  if (delta <= VISITOR_IDLE_WINDOW_MS) {
    return "idle";
  }
  return "away";
}

function conversationPriorityTs(conversation: ChatThread): number {
  return (
    toUnixMs(conversation.last_external_message_at) ??
    toUnixMs(conversation.last_message_at) ??
    0
  );
}

export async function listAgentInboxConversations(input: {
  user_id: string;
  workspace_ids: string[];
}): Promise<AgentInboxPayload> {
  if (input.workspace_ids.length === 0) {
    return {
      conversations: [],
      my_active: [],
      queue_unassigned: [],
      waiting_count: 0,
      answered_count: 0,
      high_waiting_count: 0,
      critical_waiting_count: 0
    };
  }

  let { data, error } = await supabaseAdmin
    .from("chats")
    .select("*")
    .in("workspace_id", input.workspace_ids)
    .in("conversation_mode", ["handoff_pending", "agent_active", "copilot"])
    .in("conversation_status", ["active", "waiting", "assigned"])
    .order("awaiting_agent_reply", { ascending: false })
    .order("last_external_message_at", { ascending: false, nullsFirst: false })
    .order("last_message_at", { ascending: false })
    .limit(400);

  if (error && isMissingSharedInboxColumnError(error)) {
    const fallback = await supabaseAdmin
      .from("chats")
      .select("*")
      .in("workspace_id", input.workspace_ids)
      .in("conversation_mode", ["handoff_pending", "agent_active", "copilot"])
      .in("conversation_status", ["active", "waiting", "assigned"])
      .order("last_message_at", { ascending: false })
      .limit(400);

    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new HttpError(500, `Failed to load inbox conversations: ${error.message}`);
  }

  const nowMs = Date.now();
  const conversationsWithContact = await enrichConversationsWithVisitorContact((data ?? []) as ChatThread[]);
  const conversationsWithStatus = conversationsWithContact.map((conversation) => {
    const waiting = isConversationWaitingForAgent(conversation);
    const waitingAgeSeconds = deriveWaitingAgeSeconds(conversation, nowMs);
    const waitingUrgency = waiting ? deriveWaitingUrgency(waitingAgeSeconds) : null;
    return {
      ...conversation,
      visitor_state: deriveVisitorState(conversation, nowMs),
      waiting_age_seconds: waitingAgeSeconds,
      waiting_urgency: waitingUrgency
    } as ChatThread;
  });

  conversationsWithStatus.sort((left, right) => {
    const leftWaiting = isConversationWaitingForAgent(left);
    const rightWaiting = isConversationWaitingForAgent(right);
    if (leftWaiting !== rightWaiting) {
      return rightWaiting ? 1 : -1;
    }
    if (leftWaiting && rightWaiting) {
      const urgencyDelta = waitingUrgencyRank(right.waiting_urgency) - waitingUrgencyRank(left.waiting_urgency);
      if (urgencyDelta !== 0) {
        return urgencyDelta;
      }
    }
    return conversationPriorityTs(right) - conversationPriorityTs(left);
  });

  const myActiveWithContact = conversationsWithStatus.filter(
    (conversation) => conversation.assigned_agent_id === input.user_id
  );
  const queueUnassignedWithContact = conversationsWithStatus.filter(
    (conversation) =>
      conversation.conversation_mode === "handoff_pending" && conversation.assigned_agent_id === null
  );
  const waitingConversations = conversationsWithStatus.filter((conversation) => isConversationWaitingForAgent(conversation));
  const waitingCount = waitingConversations.length;
  const answeredCount = Math.max(0, conversationsWithStatus.length - waitingCount);
  const highWaitingCount = waitingConversations.filter((conversation) => conversation.waiting_urgency === "high").length;
  const criticalWaitingCount = waitingConversations.filter((conversation) => conversation.waiting_urgency === "critical").length;

  return {
    conversations: conversationsWithStatus,
    my_active: myActiveWithContact,
    queue_unassigned: queueUnassignedWithContact,
    waiting_count: waitingCount,
    answered_count: answeredCount,
    high_waiting_count: highWaitingCount,
    critical_waiting_count: criticalWaitingCount
  };
}

export async function upsertAgentPresence(input: {
  workspace_member_id: string;
  status: AgentPresenceStatus;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("agent_presence")
    .upsert(
      {
        workspace_member_id: input.workspace_member_id,
        status: input.status,
        last_heartbeat_at: now,
        metadata: input.metadata ?? {},
        updated_at: now
      },
      { onConflict: "workspace_member_id" }
    );

  if (error) {
    throw new HttpError(500, `Failed to update agent presence: ${error.message}`);
  }
}

export async function listWorkspacePresence(workspaceId: string): Promise<Array<{
  workspace_member_id: string;
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  role: WorkspaceMemberRole;
  status: AgentPresenceStatus;
  last_heartbeat_at: string | null;
}>> {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .select(
      "id, role, user_id, platform_user:platform_users!workspace_members_user_id_fkey(full_name, email, avatar_url), presence:agent_presence!agent_presence_workspace_member_id_fkey(status, last_heartbeat_at)"
    )
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new HttpError(500, `Failed to list workspace presence: ${error.message}`);
  }

  return ((data ?? []) as Array<{
    id: string;
    role: WorkspaceMemberRole;
    user_id: string;
    platform_user:
      | { full_name: string; email: string; avatar_url: string | null }
      | Array<{ full_name: string; email: string; avatar_url: string | null }>
      | null;
    presence:
      | { status: AgentPresenceStatus; last_heartbeat_at: string | null }
      | Array<{ status: AgentPresenceStatus; last_heartbeat_at: string | null }>
      | null;
  }>).map((row) => {
    const presence = Array.isArray(row.presence) ? row.presence[0] : row.presence;
    const platformUser = takeFirst(row.platform_user);
    return {
      workspace_member_id: row.id,
      user_id: row.user_id,
      full_name: platformUser?.full_name ?? "Unknown",
      email: platformUser?.email ?? "",
      avatar_url: platformUser?.avatar_url ?? null,
      role: row.role,
      status: presence?.status ?? "offline",
      last_heartbeat_at: presence?.last_heartbeat_at ?? null
    };
  });
}

export async function listQueueConversations(input: {
  workspace_id: string;
  queue_ids: string[];
  modes?: ConversationMode[];
  include_closed?: boolean;
  limit?: number;
}): Promise<ChatThread[]> {
  if (input.queue_ids.length === 0) {
    return [];
  }

  let query = supabaseAdmin
    .from("chats")
    .select("*")
    .eq("workspace_id", input.workspace_id)
    .in("queue_id", input.queue_ids)
    .order("last_message_at", { ascending: false })
    .limit(input.limit ?? 300);

  if (input.modes && input.modes.length > 0) {
    query = query.in("conversation_mode", input.modes);
  }

  if (!input.include_closed) {
    query = query.neq("conversation_mode", "closed");
  }

  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, `Failed to load queue conversations: ${error.message}`);
  }

  return enrichConversationsWithVisitorContact((data ?? []) as ChatThread[]);
}

function isCompleteVisitorContact(contact: VisitorContactSnapshot | null | undefined): boolean {
  if (!contact) {
    return false;
  }
  return Boolean(contact.full_name?.trim() && contact.email?.trim() && contact.phone_raw?.trim());
}

function toContactKey(tenantId: string, deviceId: string): string {
  return `${tenantId}:${deviceId}`;
}

async function enrichConversationsWithVisitorContact(
  conversations: ChatThread[]
): Promise<ChatThread[]> {
  if (conversations.length === 0) {
    return [];
  }

  const tenantIds = Array.from(
    new Set(conversations.map((conversation) => conversation.tenant_id).filter(Boolean))
  );
  const deviceIds = Array.from(
    new Set(conversations.map((conversation) => conversation.device_id).filter(Boolean))
  );

  if (tenantIds.length === 0 || deviceIds.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("visitor_contacts")
    .select("tenant_id, device_id, full_name, email, phone_raw")
    .in("tenant_id", tenantIds)
    .in("device_id", deviceIds);

  if (error) {
    throw new HttpError(500, `Failed to load visitor contacts for conversations: ${error.message}`);
  }

  const contactByTenantDevice = new Map<string, VisitorContactSnapshot>();
  for (const row of (data ?? []) as VisitorContactSnapshot[]) {
    if (!isCompleteVisitorContact(row)) {
      continue;
    }
    contactByTenantDevice.set(toContactKey(row.tenant_id, row.device_id), row);
  }

  return conversations
    .map((conversation) => {
      const contact = contactByTenantDevice.get(
        toContactKey(conversation.tenant_id, conversation.device_id)
      );
      if (!contact) {
        return null;
      }

      return {
        ...conversation,
        visitor_name: contact.full_name.trim(),
        visitor_email: contact.email.trim().toLowerCase(),
        visitor_phone: contact.phone_raw.trim(),
        visitor_contact_captured: true
      } as ChatThread;
    })
    .filter(Boolean) as ChatThread[];
}

export async function listWorkspaceSupervisors(workspaceId: string): Promise<Array<{
  user_id: string;
  role: WorkspaceMemberRole;
}>> {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .in("role", ["owner", "admin", "supervisor"]);

  if (error) {
    throw new HttpError(500, `Failed to list workspace supervisors: ${error.message}`);
  }

  return (data ?? []) as Array<{ user_id: string; role: WorkspaceMemberRole }>;
}

export async function listStalePresenceMembers(input: {
  staleBefore: string;
  limit: number;
}): Promise<
  Array<{
    workspace_member_id: string;
    user_id: string;
    workspace_id: string;
    status: AgentPresenceStatus;
    last_heartbeat_at: string | null;
  }>
> {
  const { data, error } = await supabaseAdmin
    .from("agent_presence")
    .select(
      "workspace_member_id, status, last_heartbeat_at, workspace_member:workspace_members!agent_presence_workspace_member_id_fkey(user_id, workspace_id, is_active)"
    )
    .neq("status", "offline")
    .not("last_heartbeat_at", "is", null)
    .lt("last_heartbeat_at", input.staleBefore)
    .order("last_heartbeat_at", { ascending: true })
    .limit(input.limit);

  if (error) {
    throw new HttpError(500, `Failed to load stale presence candidates: ${error.message}`);
  }

  return ((data ?? []) as Array<{
    workspace_member_id: string;
    status: AgentPresenceStatus;
    last_heartbeat_at: string | null;
    workspace_member:
      | { user_id: string; workspace_id: string; is_active: boolean }
      | Array<{ user_id: string; workspace_id: string; is_active: boolean }>
      | null;
  }>)
    .map((row) => {
      const workspaceMember = takeFirst(row.workspace_member);
      if (!workspaceMember || !workspaceMember.is_active) {
        return null;
      }
      return {
        workspace_member_id: row.workspace_member_id,
        user_id: workspaceMember.user_id,
        workspace_id: workspaceMember.workspace_id,
        status: row.status,
        last_heartbeat_at: row.last_heartbeat_at
      };
    })
    .filter(Boolean) as Array<{
    workspace_member_id: string;
    user_id: string;
    workspace_id: string;
    status: AgentPresenceStatus;
    last_heartbeat_at: string | null;
  }>;
}

export async function bulkSetPresenceStatus(input: {
  workspace_member_ids: string[];
  status: AgentPresenceStatus;
}): Promise<void> {
  if (input.workspace_member_ids.length === 0) {
    return;
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("agent_presence")
    .update({
      status: input.status,
      updated_at: nowIso
    })
    .in("workspace_member_id", input.workspace_member_ids);

  if (error) {
    throw new HttpError(500, `Failed to update stale presence statuses: ${error.message}`);
  }
}

export async function listAgentLoadForQueues(input: {
  workspace_id: string;
  queue_ids: string[];
}): Promise<Array<{
  queue_id: string;
  user_id: string;
  full_name: string;
  role: WorkspaceMemberRole;
  status: AgentPresenceStatus;
  last_heartbeat_at: string | null;
  active_chats: number;
  max_concurrent_chats: number;
  priority: number;
}>> {
  if (input.queue_ids.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("queue_members")
    .select(
      "queue_id, priority, max_concurrent_chats, workspace_member:workspace_members!queue_members_workspace_member_id_fkey(id, user_id, role, is_active, platform_user:platform_users!workspace_members_user_id_fkey(full_name), presence:agent_presence!agent_presence_workspace_member_id_fkey(status, last_heartbeat_at))"
    )
    .in("queue_id", input.queue_ids)
    .eq("is_active", true);

  if (error) {
    throw new HttpError(500, `Failed to load queue member load: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    queue_id: string;
    priority: number;
    max_concurrent_chats: number;
    workspace_member:
      | {
          id: string;
          user_id: string;
          role: WorkspaceMemberRole;
          is_active: boolean;
          platform_user:
            | { full_name: string }
            | Array<{ full_name: string }>
            | null;
          presence:
            | { status: AgentPresenceStatus; last_heartbeat_at: string | null }
            | Array<{ status: AgentPresenceStatus; last_heartbeat_at: string | null }>
            | null;
        }
      | Array<{
          id: string;
          user_id: string;
          role: WorkspaceMemberRole;
          is_active: boolean;
          platform_user:
            | { full_name: string }
            | Array<{ full_name: string }>
            | null;
          presence:
            | { status: AgentPresenceStatus; last_heartbeat_at: string | null }
            | Array<{ status: AgentPresenceStatus; last_heartbeat_at: string | null }>
            | null;
        }>
      | null;
  }>;

  const candidates = rows
    .map((row) => {
      const workspaceMember = takeFirst(row.workspace_member);
      if (!workspaceMember || !workspaceMember.is_active) {
        return null;
      }

      const platformUser = takeFirst(workspaceMember.platform_user);
      const presence = takeFirst(workspaceMember.presence);

      return {
        queue_id: row.queue_id,
        user_id: workspaceMember.user_id,
        full_name: platformUser?.full_name ?? "Unknown",
        role: workspaceMember.role,
        status: presence?.status ?? "offline",
        last_heartbeat_at: presence?.last_heartbeat_at ?? null,
        max_concurrent_chats: row.max_concurrent_chats,
        priority: row.priority
      };
    })
    .filter(Boolean) as Array<{
    queue_id: string;
    user_id: string;
    full_name: string;
    role: WorkspaceMemberRole;
    status: AgentPresenceStatus;
    last_heartbeat_at: string | null;
    max_concurrent_chats: number;
    priority: number;
  }>;

  const userIds = Array.from(new Set(candidates.map((row) => row.user_id)));
  const activeCounts = await Promise.all(
    userIds.map(async (userId) => [userId, await countActiveChatsByAgent(userId)] as const)
  );
  const activeByUser = new Map(activeCounts);

  return candidates.map((row) => ({
    ...row,
    active_chats: activeByUser.get(row.user_id) ?? 0
  }));
}

export async function touchQueueMemberLastAssigned(input: {
  queue_id: string;
  user_id: string;
}): Promise<void> {
  const queue = await getQueueById(input.queue_id);
  if (!queue) {
    return;
  }

  const member = await getWorkspaceMemberByUser(queue.workspace_id, input.user_id);
  if (!member) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("queue_members")
    .update({
      last_assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("queue_id", input.queue_id)
    .eq("workspace_member_id", member.id)
    .eq("is_active", true);

  if (error) {
    throw new HttpError(500, `Failed to update queue member assignment timestamp: ${error.message}`);
  }
}
