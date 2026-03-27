import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import {
  requireWorkspaceEnterprisePlan,
  requireWorkspacePermission
} from "@/platform/permissions";
import { listSupervisorAgentLoad } from "@/services/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/supervisor/agents?tenant_id=...
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const tenantId = (url.searchParams.get("tenant_id") ?? "").trim();

    if (!tenantId) {
      return jsonCorsResponse(request, { error: "tenant_id is required" }, 400);
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "conversation:supervise"
    });
    await requireWorkspaceEnterprisePlan({
      workspaceId: tenantId,
      feature: "Supervisor dashboard"
    });

    const loads = await listSupervisorAgentLoad({
      workspaceId: tenantId,
      actorUserId: user.id
    });

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      agents: loads
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
