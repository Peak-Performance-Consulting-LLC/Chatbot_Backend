import { Redis } from "@upstash/redis";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import {
  bulkSetPresenceStatus,
  getWorkspaceMemberByUser,
  listActiveChatsByAgent,
  listStalePresenceMembers,
  listWorkspaceMemberCapacityLimits,
  listWorkspacePresence,
  type AgentEffectiveStatus,
  type AgentPresenceStatus,
  upsertAgentPresence
} from "@/agent/repository";
import { broadcastAgentNotification } from "@/services/notification";

const PRESENCE_TTL_SECONDS = 60;
const DEFAULT_AGENT_CAPACITY_LIMIT = 4;

type PresenceCacheValue = {
  status: AgentPresenceStatus;
  ts: string;
};

type WorkspacePresenceRow = {
  workspace_member_id: string;
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  role: "owner" | "admin" | "supervisor" | "agent" | "viewer";
  status: AgentPresenceStatus;
  last_heartbeat_at: string | null;
};

type EnrichedWorkspacePresenceRow = WorkspacePresenceRow & {
  active_chats: number;
  capacity_limit: number;
  is_busy: boolean;
  effective_status: AgentEffectiveStatus;
};

let redisClient: Redis | null = null;
const env = getEnv();
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  redisClient = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
}

const memoryPresence = new Map<string, PresenceCacheValue>();

function normalizePresenceStatus(input?: string): AgentPresenceStatus {
  const status = (input ?? "online").trim().toLowerCase();
  if (status === "away" || status === "offline") {
    return status;
  }
  return "online";
}

function presenceKey(workspaceId: string, workspaceMemberId: string) {
  return `presence:${workspaceId}:${workspaceMemberId}`;
}

async function writePresenceCache(
  workspaceId: string,
  workspaceMemberId: string,
  status: AgentPresenceStatus,
  ts: string
) {
  const key = presenceKey(workspaceId, workspaceMemberId);
  const payload: PresenceCacheValue = { status, ts };
  if (redisClient) {
    await redisClient.set(key, payload, { ex: PRESENCE_TTL_SECONDS });
    return;
  }

  memoryPresence.set(key, payload);
}

async function readPresenceCache(
  workspaceId: string,
  workspaceMemberId: string
): Promise<PresenceCacheValue | null> {
  const key = presenceKey(workspaceId, workspaceMemberId);
  if (redisClient) {
    const data = await redisClient.get<PresenceCacheValue>(key);
    return data ?? null;
  }

  const data = memoryPresence.get(key);
  if (!data) {
    return null;
  }
  if (Date.now() - new Date(data.ts).getTime() > PRESENCE_TTL_SECONDS * 1000) {
    memoryPresence.delete(key);
    return null;
  }
  return data;
}

async function resolveBasePresenceRows(
  workspaceId: string,
  rows: WorkspacePresenceRow[]
): Promise<WorkspacePresenceRow[]> {
  const now = Date.now();
  return Promise.all(
    rows.map(async (row) => {
      const cached = await readPresenceCache(workspaceId, row.workspace_member_id);
      if (cached) {
        return {
          ...row,
          status: cached.status,
          last_heartbeat_at: cached.ts
        };
      }

      const heartbeatMs = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0;
      const isFresh = heartbeatMs > 0 && now - heartbeatMs <= PRESENCE_TTL_SECONDS * 1000;
      return {
        ...row,
        status: isFresh ? row.status : ("offline" as const)
      };
    })
  );
}

async function enrichPresenceRows(
  workspaceId: string,
  rows: WorkspacePresenceRow[]
): Promise<EnrichedWorkspacePresenceRow[]> {
  const baseRows = await resolveBasePresenceRows(workspaceId, rows);
  if (baseRows.length === 0) {
    return [];
  }

  const [activeByUserId, capacityByMemberId] = await Promise.all([
    listActiveChatsByAgent(baseRows.map((row) => row.user_id)),
    listWorkspaceMemberCapacityLimits(baseRows.map((row) => row.workspace_member_id))
  ]);

  return baseRows.map((row) => {
    const activeChats = activeByUserId.get(row.user_id) ?? 0;
    const capacityLimit = capacityByMemberId.get(row.workspace_member_id) ?? DEFAULT_AGENT_CAPACITY_LIMIT;
    const isBusy = row.status === "online" && activeChats >= capacityLimit;
    return {
      ...row,
      active_chats: activeChats,
      capacity_limit: capacityLimit,
      is_busy: isBusy,
      effective_status: isBusy ? "busy" : row.status
    };
  });
}

function isResponderRole(role: WorkspacePresenceRow["role"]): boolean {
  return role === "owner" || role === "agent";
}

export async function heartbeatPresence(input: {
  workspaceId: string;
  userId: string;
  status?: string;
  metadata?: Record<string, unknown>;
}) {
  const member = await getWorkspaceMemberByUser(input.workspaceId, input.userId);
  if (!member) {
    throw new HttpError(403, "Workspace access denied");
  }

  const status = normalizePresenceStatus(input.status);
  const nowIso = new Date().toISOString();

  await Promise.all([
    upsertAgentPresence({
      workspace_member_id: member.id,
      status,
      metadata: input.metadata
    }),
    writePresenceCache(input.workspaceId, member.id, status, nowIso)
  ]);

  return {
    workspace_member_id: member.id,
    user_id: member.user_id,
    status,
    last_heartbeat_at: nowIso
  };
}

export async function getWorkspacePresence(input: {
  workspaceId: string;
  actorUserId: string;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }

  const rows = await listWorkspacePresence(input.workspaceId);
  return enrichPresenceRows(input.workspaceId, rows as WorkspacePresenceRow[]);
}

export async function getWorkspaceLiveSupportAvailability(workspaceId: string): Promise<{
  availability: AgentEffectiveStatus;
  online_count: number;
  busy_count: number;
  away_count: number;
  updated_at: string;
}> {
  const rows = await listWorkspacePresence(workspaceId);
  const enriched = await enrichPresenceRows(workspaceId, rows as WorkspacePresenceRow[]);
  const responderRows = enriched.filter((row) => isResponderRole(row.role));

  const onlineCount = responderRows.filter((row) => row.effective_status === "online").length;
  const busyCount = responderRows.filter((row) => row.effective_status === "busy").length;
  const awayCount = responderRows.filter((row) => row.effective_status === "away").length;

  const availability: AgentEffectiveStatus =
    onlineCount > 0 ? "online" : busyCount > 0 ? "busy" : awayCount > 0 ? "away" : "offline";

  return {
    availability,
    online_count: onlineCount,
    busy_count: busyCount,
    away_count: awayCount,
    updated_at: new Date().toISOString()
  };
}

export async function runPresenceMaintenanceSweep(limit = 300): Promise<{
  scanned: number;
  markedOffline: number;
}> {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_SECONDS * 1000).toISOString();
  const staleMembers = await listStalePresenceMembers({
    staleBefore: cutoff,
    limit
  });
  if (staleMembers.length === 0) {
    return {
      scanned: 0,
      markedOffline: 0
    };
  }

  await bulkSetPresenceStatus({
    workspace_member_ids: staleMembers.map((item) => item.workspace_member_id),
    status: "offline"
  });

  await Promise.all(
    staleMembers.map((member) =>
      broadcastAgentNotification(member.user_id, "presence", {
        workspace_id: member.workspace_id,
        user_id: member.user_id,
        status: "offline",
        stale_heartbeat_at: member.last_heartbeat_at
      }).catch(() => undefined)
    )
  );

  return {
    scanned: staleMembers.length,
    markedOffline: staleMembers.length
  };
}
