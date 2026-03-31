import { HttpError } from "@/lib/httpError";
import { logInfo, logError } from "@/lib/logger";
import { getEnv } from "@/config/env";
import {
  acceptConversationWithOptimisticLock,
  getChatById,
  updateChatMode,
  insertConversationEvent
} from "@/chat/repository";
import type { ChatThread, ConversationMode, ConversationStatus } from "@/chat/types";

// ── Mode Transition Rules ──────────────────────────────────────────
// Defines allowed transitions and validates them before execution.

const ALLOWED_TRANSITIONS: Record<ConversationMode, ConversationMode[]> = {
  ai_only: ["handoff_pending", "closed"],
  handoff_pending: ["agent_active", "ai_only", "closed"],
  agent_active: ["copilot", "returned_to_ai", "closed"],
  copilot: ["agent_active", "returned_to_ai", "closed"],
  returned_to_ai: ["handoff_pending", "ai_only", "closed"],
  closed: [] // terminal state
};

export function validateModeTransition(from: ConversationMode, to: ConversationMode): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function modeToStatus(mode: ConversationMode) {
  switch (mode) {
    case "ai_only":
    case "returned_to_ai":
      return "active" as const;
    case "handoff_pending":
      return "waiting" as const;
    case "agent_active":
    case "copilot":
      return "assigned" as const;
    case "closed":
      return "closed" as const;
  }
}

function getHandoffEnabledTenantSet(): Set<string> {
  const raw = getEnv().HANDOFF_ENABLED_TENANTS;
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

// ── Public API ─────────────────────────────────────────────────────

export function isHandoffEnabledForTenant(tenantId: string): boolean {
  const allowedTenants = getHandoffEnabledTenantSet();
  if (allowedTenants.size === 0) {
    return true;
  }

  return allowedTenants.has(tenantId.trim());
}

export async function getConversationMode(chatId: string): Promise<ConversationMode> {
  const chat = await getChatById(chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }
  return chat.conversation_mode ?? "ai_only";
}

export async function transitionMode(input: {
  chatId: string;
  toMode: ConversationMode;
  actorId?: string | null;
  actorType?: string | null;
  eventType?: string;
  metadata?: Record<string, unknown>;
  statusOverride?: ConversationStatus;
    updates?: {
      assigned_agent_id?: string | null;
      handoff_requested_at?: string | null;
      assigned_at?: string | null;
      closed_at?: string | null;
      queue_id?: string | null;
      workspace_id?: string | null;
      visitor_is_vip?: boolean;
      routing_skill?: string | null;
      sla_started_at?: string | null;
      sla_first_response_due_at?: string | null;
      first_agent_response_at?: string | null;
      sla_warning_sent_at?: string | null;
      sla_breached?: boolean;
      sla_breached_at?: string | null;
      overflowed_at?: string | null;
      archived_at?: string | null;
    };
}): Promise<ChatThread> {
  const chat = await getChatById(input.chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const from = chat.conversation_mode ?? "ai_only";
  if (!validateModeTransition(from, input.toMode)) {
    throw new HttpError(409, `Cannot transition from mode '${from}' to '${input.toMode}'`);
  }

  const updated = await updateChatMode(input.chatId, {
    conversation_mode: input.toMode,
    conversation_status: input.statusOverride ?? modeToStatus(input.toMode),
    ...(input.updates ?? {})
  });

  if (input.eventType) {
    await insertConversationEvent({
      chat_id: input.chatId,
      event_type: input.eventType,
      actor_id: input.actorId ?? null,
      actor_type: input.actorType ?? null,
      old_mode: from,
      new_mode: input.toMode,
      metadata: input.metadata ?? {}
    }).catch((err) =>
      logError("conversation_event_insert_failed", {
        chat_id: input.chatId,
        event: input.eventType,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }

  return updated;
}

export async function requestHandoff(chatId: string): Promise<ChatThread> {
  return requestHandoffWithOptions(chatId, {});
}

export async function requestHandoffWithOptions(
  chatId: string,
  options: {
    actorType?: string | null;
    eventType?: string;
    metadata?: Record<string, unknown>;
    updates?: {
      queue_id?: string | null;
      workspace_id?: string | null;
      visitor_is_vip?: boolean;
      routing_skill?: string | null;
      handoff_requested_at?: string | null;
      sla_started_at?: string | null;
      sla_first_response_due_at?: string | null;
      first_agent_response_at?: string | null;
      sla_warning_sent_at?: string | null;
      sla_breached?: boolean;
      sla_breached_at?: string | null;
      overflowed_at?: string | null;
      archived_at?: string | null;
    };
  }
): Promise<ChatThread> {
  const updated = await transitionMode({
    chatId,
    toMode: "handoff_pending",
    actorType: options.actorType ?? "visitor",
    eventType: options.eventType ?? "handoff_requested",
    statusOverride: "waiting",
    updates: {
      handoff_requested_at: new Date().toISOString(),
      ...(options.updates ?? {})
    },
    metadata: options.metadata ?? {}
  });
  logInfo("conversation_handoff_requested", { chat_id: chatId });

  return updated;
}

export async function acceptConversation(
  chatId: string,
  agentUserId: string
): Promise<ChatThread> {
  const chat = await getChatById(chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const from = chat.conversation_mode ?? "ai_only";
  if (!validateModeTransition(from, "agent_active")) {
    throw new HttpError(409, `Cannot accept conversation in mode '${from}'`);
  }

  const updated = await acceptConversationWithOptimisticLock(chatId, agentUserId);
  if (!updated) {
    const latest = await getChatById(chatId);
    if (!latest) {
      throw new HttpError(404, "Conversation not found");
    }

    throw new HttpError(
      409,
      `Conversation accept failed because mode is now '${latest.conversation_mode ?? "ai_only"}'`
    );
  }

  await insertConversationEvent({
    chat_id: chatId,
    event_type: "agent_accepted",
    actor_id: agentUserId,
    actor_type: "agent",
    old_mode: from,
    new_mode: "agent_active",
    metadata: { agent_id: agentUserId }
  }).catch((err) =>
    logError("conversation_event_insert_failed", {
      chat_id: chatId,
      event: "agent_accepted",
      error: err instanceof Error ? err.message : String(err)
    })
  );

  logInfo("conversation_agent_accepted", {
    chat_id: chatId,
    agent_id: agentUserId,
    from_mode: from
  });

  return updated;
}

export async function returnToAI(
  chatId: string,
  agentUserId: string
): Promise<ChatThread> {
  const chat = await getChatById(chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const from = chat.conversation_mode ?? "ai_only";

  const updated = await transitionMode({
    chatId,
    toMode: "returned_to_ai",
    actorId: agentUserId,
    actorType: "agent",
    eventType: "returned_to_ai",
    metadata: { agent_id: agentUserId },
    updates: {
      assigned_agent_id: null,
      assigned_at: null
    }
  });

  logInfo("conversation_returned_to_ai", {
    chat_id: chatId,
    agent_id: agentUserId,
    from_mode: from
  });

  return updated;
}

export async function closeConversation(
  chatId: string,
  actorId?: string,
  actorType?: string
): Promise<ChatThread> {
  const chat = await getChatById(chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const from = chat.conversation_mode ?? "ai_only";
  if (from === "closed") {
    return chat; // idempotent
  }

  const updated = await transitionMode({
    chatId,
    toMode: "closed",
    actorId: actorId ?? null,
    actorType: actorType ?? null,
    eventType: "conversation_closed",
    statusOverride: "closed",
    updates: {
      closed_at: new Date().toISOString(),
      assigned_agent_id: null,
      assigned_at: null
    }
  });

  logInfo("conversation_closed", {
    chat_id: chatId,
    actor_id: actorId,
    from_mode: from
  });

  return updated;
}

export async function setCopilotMode(input: {
  chatId: string;
  agentUserId: string;
  enabled: boolean;
}): Promise<ChatThread> {
  const chat = await getChatById(input.chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const targetMode: ConversationMode = input.enabled ? "copilot" : "agent_active";
  if (chat.conversation_mode === targetMode) {
    return chat;
  }

  const updated = await transitionMode({
    chatId: input.chatId,
    toMode: targetMode,
    actorId: input.agentUserId,
    actorType: "agent",
    eventType: input.enabled ? "copilot_enabled" : "copilot_disabled",
    metadata: {
      agent_id: input.agentUserId
    }
  });

  logInfo("conversation_copilot_toggled", {
    chat_id: input.chatId,
    agent_id: input.agentUserId,
    enabled: input.enabled
  });

  return updated;
}

/**
 * Checks if the conversation is in a mode that allows AI to respond.
 */
export function isAIModeActive(mode: ConversationMode): boolean {
  return mode === "ai_only" || mode === "returned_to_ai";
}

/**
 * Returns a short system message to insert when mode changes.
 */
export function getModeTransitionMessage(
  newMode: ConversationMode,
  agentName?: string
): string | null {
  switch (newMode) {
    case "handoff_pending":
      return "Connecting you with a live agent...";
    case "agent_active":
      return agentName
        ? `${agentName} has joined the conversation.`
        : "An agent has joined the conversation.";
    case "copilot":
      return "Copilot is enabled. AI can suggest drafts for the assigned agent.";
    case "returned_to_ai":
      return "The conversation has been returned to the AI assistant.";
    case "closed":
      return "This conversation has been closed.";
    default:
      return null;
  }
}
