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
  PLATFORM_AUTO_INGEST_ON_SIGNUP: z.string().optional(),
  PLATFORM_AUTO_INGEST_ON_SOURCE_UPDATE: z.string().optional(),
  PLATFORM_APP_URL: z.string().default("http://localhost:5173"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(""),
  FACEBOOK_OAUTH_APP_ID: z.string().default(""),
  FACEBOOK_OAUTH_APP_SECRET: z.string().default(""),
  WIDGET_HOST_URL: z.string().default("http://localhost:5173"),
  BACKEND_PUBLIC_URL: z.string().default("http://localhost:3000"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_STARTER: z.string().default(""),
  STRIPE_PRICE_GROWTH: z.string().default(""),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  PLATFORM_PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  PLATFORM_PASSWORD_RESET_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  PLATFORM_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60)
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
