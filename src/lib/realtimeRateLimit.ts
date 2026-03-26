import { getEnv } from "@/config/env";
import { enforceRateLimitWithConfig } from "@/lib/rateLimit";

export async function canBroadcastRealtimeEvent(input: {
  channel: string;
  event: string;
}): Promise<boolean> {
  const env = getEnv();
  const result = await enforceRateLimitWithConfig(
    `realtime:${input.channel}:${input.event}`,
    {
      maxRequests: env.REALTIME_RATE_LIMIT_MAX_EVENTS,
      windowMs: env.REALTIME_RATE_LIMIT_WINDOW_MS
    }
  );

  return result.allowed;
}

