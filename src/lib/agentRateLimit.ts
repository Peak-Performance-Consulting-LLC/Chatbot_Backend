import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { enforceRateLimitWithConfig } from "@/lib/rateLimit";

export async function enforceAgentApiRateLimit(key: string): Promise<void> {
  const env = getEnv();
  const result = await enforceRateLimitWithConfig(key, {
    maxRequests: env.AGENT_API_RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.AGENT_API_RATE_LIMIT_WINDOW_MS
  });

  if (!result.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw new HttpError(
      429,
      `Too many requests. Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`
    );
  }
}

