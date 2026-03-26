import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv } from "@/config/env";

type RateLimitResult = {
  allowed: boolean;
  resetAt: number;
};

type RateLimitConfig = {
  maxRequests: number;
  windowMs: number;
};

const env = getEnv();

let ratelimit: Ratelimit | null = null;
let redisClient: Redis | null = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  redisClient = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });

  ratelimit = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(env.RATE_LIMIT_MAX_REQUESTS, `${env.RATE_LIMIT_WINDOW_MS} ms`)
  });
}

const memoryState = new Map<string, { count: number; resetAt: number }>();
const ratelimitByConfig = new Map<string, Ratelimit>();

function toConfigKey(config: RateLimitConfig): string {
  return `${config.maxRequests}:${config.windowMs}`;
}

function getRatelimitForConfig(config: RateLimitConfig): Ratelimit | null {
  if (!redisClient) {
    return null;
  }

  if (
    config.maxRequests === env.RATE_LIMIT_MAX_REQUESTS &&
    config.windowMs === env.RATE_LIMIT_WINDOW_MS &&
    ratelimit
  ) {
    return ratelimit;
  }

  const key = toConfigKey(config);
  const cached = ratelimitByConfig.get(key);
  if (cached) {
    return cached;
  }

  const created = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(config.maxRequests, `${config.windowMs} ms`)
  });
  ratelimitByConfig.set(key, created);
  return created;
}

export async function enforceRateLimitWithConfig(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const limiter = getRatelimitForConfig(config);
  if (limiter) {
    const result = await limiter.limit(key);
    return {
      allowed: result.success,
      resetAt: result.reset
    };
  }

  const namespacedKey = `${toConfigKey(config)}:${key}`;
  const now = Date.now();
  const current = memoryState.get(namespacedKey);
  if (!current || current.resetAt <= now) {
    const resetAt = now + config.windowMs;
    memoryState.set(namespacedKey, {
      count: 1,
      resetAt
    });
    return { allowed: true, resetAt };
  }

  current.count += 1;
  memoryState.set(namespacedKey, current);

  return {
    allowed: current.count <= config.maxRequests,
    resetAt: current.resetAt
  };
}

export async function enforceRateLimit(key: string): Promise<RateLimitResult> {
  return enforceRateLimitWithConfig(key, {
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_MS
  });
}
