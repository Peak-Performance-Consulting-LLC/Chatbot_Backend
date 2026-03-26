import { Redis } from "@upstash/redis";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import {
  bulkSetPresenceStatus,
  getWorkspaceMemberByUser,
  listStalePresenceMembers,
  listWorkspacePresence,
  type AgentPresenceStatus,
  upsertAgentPresence
} from "@/agent/repository";
import { broadcastAgentNotification } from "@/services/notification";

const PRESENCE_TTL_SECONDS = 60;

type PresenceCacheValue = {
  status: AgentPresenceStatus;
  ts: string;
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
  const now = Date.now();
  const result = await Promise.all(
    rows.map(async (row) => {
      const cached = await readPresenceCache(input.workspaceId, row.workspace_member_id);
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

  return result;
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
