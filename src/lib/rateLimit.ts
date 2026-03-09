import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv } from "@/config/env";

type RateLimitResult = {
  allowed: boolean;
  resetAt: number;
};

const env = getEnv();

let ratelimit: Ratelimit | null = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });

  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(env.RATE_LIMIT_MAX_REQUESTS, `${env.RATE_LIMIT_WINDOW_MS} ms`)
  });
}

const memoryState = new Map<string, { count: number; resetAt: number }>();

export async function enforceRateLimit(key: string): Promise<RateLimitResult> {
  if (ratelimit) {
    const result = await ratelimit.limit(key);
    return {
      allowed: result.success,
      resetAt: result.reset
    };
  }

  const now = Date.now();
  const current = memoryState.get(key);
  if (!current || current.resetAt <= now) {
    memoryState.set(key, {
      count: 1,
      resetAt: now + env.RATE_LIMIT_WINDOW_MS
    });
    return { allowed: true, resetAt: now + env.RATE_LIMIT_WINDOW_MS };
  }

  current.count += 1;
  memoryState.set(key, current);

  return {
    allowed: current.count <= env.RATE_LIMIT_MAX_REQUESTS,
    resetAt: current.resetAt
  };
}
