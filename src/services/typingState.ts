export type TypingActor = "agent" | "visitor";

export type TypingStatePayload = {
  chat_id: string;
  conversationId: string;
  actor: TypingActor;
  user_id: string;
  userId: string;
  userName?: string;
  is_typing: boolean;
  updated_at: string;
};

type TypingEntry = {
  conversationId: string;
  actor: TypingActor;
  userId: string;
  userName?: string;
  updatedAtMs: number;
  updatedAtIso: string;
};

const TYPING_TTL_MS = 8000;
const GLOBAL_TYPING_STATE_KEY = "__aeroconciergeTypingState";

type GlobalTypingState = typeof globalThis & {
  [GLOBAL_TYPING_STATE_KEY]?: Map<string, Partial<Record<TypingActor, TypingEntry>>>;
};

const globalTypingState = globalThis as GlobalTypingState;
const typingByConversation =
  globalTypingState[GLOBAL_TYPING_STATE_KEY] ??
  new Map<string, Partial<Record<TypingActor, TypingEntry>>>();

globalTypingState[GLOBAL_TYPING_STATE_KEY] = typingByConversation;

function toPayload(entry: TypingEntry): TypingStatePayload {
  return {
    chat_id: entry.conversationId,
    conversationId: entry.conversationId,
    actor: entry.actor,
    user_id: entry.userId,
    userId: entry.userId,
    userName: entry.userName,
    is_typing: true,
    updated_at: entry.updatedAtIso
  };
}

function pruneConversation(conversationId: string, nowMs = Date.now()) {
  const state = typingByConversation.get(conversationId);
  if (!state) {
    return null;
  }

  for (const actor of ["agent", "visitor"] as const) {
    const entry = state[actor];
    if (entry && nowMs - entry.updatedAtMs > TYPING_TTL_MS) {
      delete state[actor];
    }
  }

  if (!state.agent && !state.visitor) {
    typingByConversation.delete(conversationId);
    return null;
  }

  return state;
}

export function recordTypingState(input: {
  conversationId: string;
  actor: TypingActor;
  userId: string;
  userName?: string | null;
  isTyping: boolean;
}) {
  const nowMs = Date.now();
  const updatedAtIso = new Date(nowMs).toISOString();
  const existing = pruneConversation(input.conversationId, nowMs) ?? {};

  if (!input.isTyping) {
    delete existing[input.actor];
    if (!existing.agent && !existing.visitor) {
      typingByConversation.delete(input.conversationId);
    } else {
      typingByConversation.set(input.conversationId, existing);
    }
    return;
  }

  existing[input.actor] = {
    conversationId: input.conversationId,
    actor: input.actor,
    userId: input.userId,
    userName: input.userName?.trim() || undefined,
    updatedAtMs: nowMs,
    updatedAtIso
  };
  typingByConversation.set(input.conversationId, existing);
}

export function getConversationTypingState(conversationId: string) {
  const state = pruneConversation(conversationId);
  return {
    agent: state?.agent ? toPayload(state.agent) : null,
    visitor: state?.visitor ? toPayload(state.visitor) : null
  };
}

export function getTypingPayloadFromTimestamp(input: {
  conversationId: string;
  actor: TypingActor;
  userId: string;
  userName?: string | null;
  timestamp?: string | null;
}): TypingStatePayload | null {
  if (!input.timestamp) {
    return null;
  }

  const timestampMs = new Date(input.timestamp).getTime();
  if (!Number.isFinite(timestampMs) || Date.now() - timestampMs > TYPING_TTL_MS) {
    return null;
  }

  return {
    chat_id: input.conversationId,
    conversationId: input.conversationId,
    actor: input.actor,
    user_id: input.userId,
    userId: input.userId,
    userName: input.userName?.trim() || undefined,
    is_typing: true,
    updated_at: input.timestamp
  };
}
