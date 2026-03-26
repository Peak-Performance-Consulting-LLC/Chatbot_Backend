import { jsonCorsResponse } from "@/lib/cors";
import { getEnv } from "@/config/env";
import { runSlaMaintenanceSweep } from "@/services/sla";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = getEnv().CRON_SECRET?.trim();
  if (!secret) {
    return true;
  }

  const authHeader = request.headers.get("authorization")?.trim();
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === secret) {
      return true;
    }
  }

  const direct = request.headers.get("x-cron-secret")?.trim();
  return direct === secret;
}

/**
 * GET /api/cron/sla-breach
 * Run every 30s via Vercel cron.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return jsonCorsResponse(request, { error: "Unauthorized" }, 401);
  }

  try {
    const result = await runSlaMaintenanceSweep(500);
    return jsonCorsResponse(request, {
      ok: true,
      ...result
    });
  } catch (error) {
    return jsonCorsResponse(
      request,
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      500
    );
  }
}
