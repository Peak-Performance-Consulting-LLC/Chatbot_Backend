import { getEnv } from "@/config/env";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  const env = getEnv();

  return jsonCorsResponse(request, {
    status: "ok",
    timestamp: new Date().toISOString(),
    deployment: {
      node_env: process.env.NODE_ENV ?? "development",
      vercel_env: process.env.VERCEL_ENV ?? null
    },
    services: {
      supabase_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      gemini_configured: Boolean(env.GEMINI_API_KEY),
      upstash_configured: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
    }
  });
}
