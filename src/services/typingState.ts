import { Redis } from "@upstash/redis";
import { getEnv } from "@/config/env";

export type TypingActor = "agent" | "visitor";

export type TypingStatePayload = {
  chat_id: string;
  chatId: string;
  conversation_id: string;
  conversationId: string;
  actor: TypingActor;
  sender_type: TypingActor;
  user_id: string;
  sender_id: string;
  userId: string;
  userName?: string;
  user_name?: string;
  senderName?: string;
  is_typing: boolean;
  isTyping: boolean;
  typing: boolean;
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
const TYPING_TTL_SECONDS = Math.ceil(TYPING_TTL_MS / 1000);
const GLOBAL_TYPING_STATE_KEY = "__aeroconciergeTypingState";

const env = getEnv();
const redisClient =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN
      })
    : null;

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
    chatId: entry.conversationId,
    conversation_id: entry.conversationId,
    conversationId: entry.conversationId,
    actor: entry.actor,
    sender_type: entry.actor,
    user_id: entry.userId,
    sender_id: entry.userId,
    userId: entry.userId,
    userName: entry.userName,
    user_name: entry.userName,
    senderName: entry.userName,
    is_typing: true,
    isTyping: true,
    typing: true,
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

function typingKey(conversationId: string, actor: TypingActor) {
  return `typing:${conversationId}:${actor}`;
}

async function writeRedisTypingEntry(entry: TypingEntry) {
  if (!redisClient) {
    return;
  }

  await redisClient.set(typingKey(entry.conversationId, entry.actor), entry, {
    ex: TYPING_TTL_SECONDS
  });
}

async function deleteRedisTypingEntry(conversationId: string, actor: TypingActor) {
  if (!redisClient) {
    return;
  }

  await redisClient.del(typingKey(conversationId, actor));
}

async function readRedisTypingEntry(
  conversationId: string,
  actor: TypingActor,
  nowMs = Date.now()
): Promise<TypingEntry | null> {
  if (!redisClient) {
    return null;
  }

  const entry = await redisClient.get<TypingEntry>(typingKey(conversationId, actor));
  if (!entry || nowMs - entry.updatedAtMs > TYPING_TTL_MS) {
    return null;
  }
  return entry;
}

export async function recordTypingState(input: {
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
    await deleteRedisTypingEntry(input.conversationId, input.actor).catch(() => undefined);
    return;
  }

  const entry: TypingEntry = {
    conversationId: input.conversationId,
    actor: input.actor,
    userId: input.userId,
    userName: input.userName?.trim() || undefined,
    updatedAtMs: nowMs,
    updatedAtIso
  };
  existing[input.actor] = entry;
  typingByConversation.set(input.conversationId, existing);
  await writeRedisTypingEntry(entry).catch(() => undefined);
}

export async function getConversationTypingState(conversationId: string) {
  const nowMs = Date.now();
  const state = pruneConversation(conversationId);
  const redisAgent = state?.agent ? null : await readRedisTypingEntry(conversationId, "agent", nowMs).catch(() => null);
  const redisVisitor = state?.visitor
    ? null
    : await readRedisTypingEntry(conversationId, "visitor", nowMs).catch(() => null);

  return {
    agent: state?.agent ? toPayload(state.agent) : redisAgent ? toPayload(redisAgent) : null,
    visitor: state?.visitor ? toPayload(state.visitor) : redisVisitor ? toPayload(redisVisitor) : null
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
    chatId: input.conversationId,
    conversation_id: input.conversationId,
    conversationId: input.conversationId,
    actor: input.actor,
    sender_type: input.actor,
    user_id: input.userId,
    sender_id: input.userId,
    userId: input.userId,
    userName: input.userName?.trim() || undefined,
    user_name: input.userName?.trim() || undefined,
    senderName: input.userName?.trim() || undefined,
    is_typing: true,
    isTyping: true,
    typing: true,
    updated_at: input.timestamp
  };
}
