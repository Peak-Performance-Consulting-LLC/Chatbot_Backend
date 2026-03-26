import {
  countActiveChatsByAgent,
  listPresenceForWorkspaceMembers,
  listQueueMembersWithAgent,
  type QueueRecord
} from "@/agent/repository";

const PRESENCE_TTL_MS = 60_000;

type EligibleAgent = {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  workspaceMemberId: string;
  priority: number;
  activeChats: number;
  capacity: number;
  skills: string[];
  handlesVip: boolean;
  lastAssignedAt: string | null;
};

type RoutingSelectionStrategy = "priority_least_active" | "round_robin";

export type QueueRoutingSelectionOptions = {
  requiredSkill?: string | null;
  isVip?: boolean;
  routingStrategy?: RoutingSelectionStrategy;
};

export type BusinessHoursDayConfig = {
  enabled?: boolean;
  start?: string;
  end?: string;
};

export type BusinessHoursConfig = {
  timezone?: string;
  days?: Record<string, BusinessHoursDayConfig>;
};

const DAY_KEYS: Record<string, string> = {
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
  sun: "sun"
};

function isPresenceFresh(lastHeartbeatAt: string | null): boolean {
  if (!lastHeartbeatAt) {
    return false;
  }
  const ts = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(ts)) {
    return false;
  }
  return Date.now() - ts <= PRESENCE_TTL_MS;
}

function parseMinutes(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function getLocalWeekdayAndMinutes(timezone: string, now: Date): {
  weekday: string | null;
  minutes: number | null;
} {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const weekdayRaw = parts.find((part) => part.type === "weekday")?.value?.toLowerCase() ?? "";
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "");
    const weekday = DAY_KEYS[weekdayRaw.slice(0, 3)] ?? null;
    const minutes = Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
    return { weekday, minutes };
  } catch {
    return { weekday: null, minutes: null };
  }
}

export function isWithinBusinessHours(
  businessHours: Record<string, unknown> | null | undefined,
  now = new Date()
): boolean {
  if (!businessHours || typeof businessHours !== "object") {
    return true;
  }

  const config = businessHours as unknown as BusinessHoursConfig;
  const days = config.days;
  if (!days || typeof days !== "object") {
    return true;
  }

  const timezone = typeof config.timezone === "string" && config.timezone.trim()
    ? config.timezone.trim()
    : "UTC";
  const { weekday, minutes } = getLocalWeekdayAndMinutes(timezone, now);
  if (!weekday || minutes === null) {
    return true;
  }

  const today = days[weekday];
  if (!today || typeof today !== "object") {
    return false;
  }
  if (today.enabled === false) {
    return false;
  }

  const start = parseMinutes(today.start);
  const end = parseMinutes(today.end);
  if (start === null || end === null) {
    return true;
  }

  if (start === end) {
    return true;
  }
  if (start < end) {
    return minutes >= start && minutes < end;
  }
  return minutes >= start || minutes < end;
}

export function buildSlaTargetsForQueue(queue: QueueRecord, now = new Date()): {
  sla_started_at: string;
  sla_first_response_due_at: string;
} {
  const firstResponseSeconds = Number.isFinite(queue.sla_first_response_seconds)
    ? queue.sla_first_response_seconds
    : 180;
  const started = now;
  const due = new Date(started.getTime() + Math.max(0, firstResponseSeconds) * 1000);
  return {
    sla_started_at: started.toISOString(),
    sla_first_response_due_at: due.toISOString()
  };
}

export async function findEligibleAgentForQueue(
  queueId: string,
  options?: QueueRoutingSelectionOptions
): Promise<EligibleAgent | null> {
  const queueMembers = await listQueueMembersWithAgent(queueId);
  if (queueMembers.length === 0) {
    return null;
  }

  const workspaceMemberIds = queueMembers
    .map((member) => member.workspace_member_id)
    .filter(Boolean);
  const presenceRows = await listPresenceForWorkspaceMembers(workspaceMemberIds);
  const presenceByMemberId = new Map(
    presenceRows.map((row) => [row.workspace_member_id, row] as const)
  );

  const candidateInputs = queueMembers
    .map((queueMember) => {
      const workspaceMember = queueMember.workspace_member;
      const user = workspaceMember?.platform_user;
      if (!workspaceMember || !user || !workspaceMember.is_active || !queueMember.is_active) {
        return null;
      }

      const presence = presenceByMemberId.get(queueMember.workspace_member_id);
      if (!presence || presence.status !== "online" || !isPresenceFresh(presence.last_heartbeat_at)) {
        return null;
      }

      return {
        queueMember,
        workspaceMember,
        user
      };
    })
    .filter(Boolean) as Array<{
    queueMember: (typeof queueMembers)[number];
    workspaceMember: NonNullable<(typeof queueMembers)[number]["workspace_member"]>;
    user: NonNullable<NonNullable<(typeof queueMembers)[number]["workspace_member"]>["platform_user"]>;
  }>;

  if (candidateInputs.length === 0) {
    return null;
  }

  const candidateLoads = await Promise.all(
    candidateInputs.map(async (candidate) => {
      const activeChats = await countActiveChatsByAgent(candidate.user.id);
      return {
        candidate,
        activeChats
      };
    })
  );

  let eligible = candidateLoads
    .filter(
      (entry) => entry.activeChats < entry.candidate.queueMember.max_concurrent_chats
    )
    .map((entry) => ({
      userId: entry.candidate.user.id,
      fullName: entry.candidate.user.full_name,
      avatarUrl: entry.candidate.user.avatar_url,
      workspaceMemberId: entry.candidate.workspaceMember.id,
      priority: entry.candidate.queueMember.priority,
      activeChats: entry.activeChats,
      capacity: entry.candidate.queueMember.max_concurrent_chats,
      skills: (entry.candidate.queueMember.skills ?? [])
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean),
      handlesVip: entry.candidate.queueMember.handles_vip ?? true,
      lastAssignedAt: entry.candidate.queueMember.last_assigned_at ?? null
    }));

  if (eligible.length === 0) {
    return null;
  }

  const requiredSkill = options?.requiredSkill?.trim().toLowerCase();
  if (requiredSkill) {
    const strictMatches = eligible.filter((candidate) => candidate.skills.includes(requiredSkill));
    if (strictMatches.length > 0) {
      eligible = strictMatches;
    }
  }

  if (options?.isVip) {
    const vipPreferred = eligible.filter((candidate) => candidate.handlesVip);
    if (vipPreferred.length > 0) {
      eligible = vipPreferred;
    }
  }

  const strategy: RoutingSelectionStrategy = options?.routingStrategy ?? "priority_least_active";
  if (strategy === "round_robin") {
    eligible.sort((a, b) => {
      const aTs = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
      const bTs = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
      if (aTs !== bTs) {
        return aTs - bTs;
      }
      if (a.activeChats !== b.activeChats) {
        return a.activeChats - b.activeChats;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.userId.localeCompare(b.userId);
    });
  } else {
    eligible.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      if (a.activeChats !== b.activeChats) {
        return a.activeChats - b.activeChats;
      }
      return a.userId.localeCompare(b.userId);
    });
  }

  return eligible[0] ?? null;
}

export function classifyRoutingSkill(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/(flight|airfare|ticket|itinerary|iata|airport|layover|departure|arrival)/.test(normalized)) {
    return "flights";
  }
  if (/(hotel|resort|room|suite|check[-\s]?in|check[-\s]?out|accommodation)/.test(normalized)) {
    return "hotels";
  }
  if (/(car rental|car hire|rent a car|vehicle|pickup|dropoff|drop-off|sedan|suv)/.test(normalized)) {
    return "cars";
  }
  if (/(cruise|ship|cabin deck|shore excursion|port stop)/.test(normalized)) {
    return "cruises";
  }
  if (/(payment|refund|charge|billing|invoice|receipt|card declined|transaction)/.test(normalized)) {
    return "billing";
  }

  return "support";
}
