import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_ALLOWED_ORIGINS: z.string().default(""),
  CORS_STRICT: z.coerce.boolean().default(false),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_CHAT_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  FLIGHT_SEARCH_URL: z.string().default("https://serp-api-olive.vercel.app/api/flights/search"),
  FLIGHT_PLACE_SUGGESTIONS_URL: z
    .string()
    .default("https://serp-api-olive.vercel.app/api/flights/place-suggestions"),
  CALL_CTA_NUMBER: z.string().default("+18772469013"),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  PLATFORM_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  WIDGET_HOST_URL: z.string().default("http://localhost:5173"),
  BACKEND_PUBLIC_URL: z.string().default("http://localhost:4000"),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000)
});

export type AppEnv = z.infer<typeof envSchema> & {
  allowedOrigins: string[];
};

let cachedEnv: AppEnv | null = null;

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const sanitized = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [
      key,
      typeof value === "string" ? stripWrappingQuotes(value) : value
    ])
  );

  const parsed = envSchema.parse(sanitized);
  cachedEnv = {
    ...parsed,
    allowedOrigins: parsed.NEXT_PUBLIC_ALLOWED_ORIGINS.split(",")
      .map((item) => stripWrappingQuotes(item).replace(/\/$/, ""))
      .filter(Boolean)
  };

  return cachedEnv;
}

export function assertEnvVars(requiredKeys: Array<keyof AppEnv>) {
  const env = getEnv();
  const missing = requiredKeys.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
