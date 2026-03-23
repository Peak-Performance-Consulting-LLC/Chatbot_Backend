import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";

const requestState = new Map<string, { count: number; resetAt: number }>();

function getLimitConfig() {
  const env = getEnv();
  return {
    maxRequests: env.PLATFORM_PASSWORD_RESET_RATE_LIMIT_MAX ?? env.RATE_LIMIT_MAX ?? 5,
    windowMs: env.PLATFORM_PASSWORD_RESET_WINDOW_MS
  };
}

export function enforcePlatformPasswordResetRateLimit(key: string) {
  const { maxRequests, windowMs } = getLimitConfig();
  const now = Date.now();
  const current = requestState.get(key);

  if (!current || current.resetAt <= now) {
    requestState.set(key, {
      count: 1,
      resetAt: now + windowMs
    });
    return;
  }

  current.count += 1;
  requestState.set(key, current);

  if (current.count > maxRequests) {
    const retryInSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw new HttpError(
      429,
      `Too many password reset attempts. Please wait ${retryInSeconds} second${retryInSeconds === 1 ? "" : "s"} and try again.`
    );
  }
}
