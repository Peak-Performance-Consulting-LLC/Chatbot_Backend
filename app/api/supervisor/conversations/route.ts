import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import {
  requireWorkspaceEnterprisePlan,
  requireWorkspacePermission
} from "@/platform/permissions";
import { listSupervisorQueueConversations } from "@/services/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/supervisor/conversations?tenant_id=...&include_closed=1
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const tenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    const includeClosed = url.searchParams.get("include_closed") === "1";

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

    const conversations = await listSupervisorQueueConversations({
      workspaceId: tenantId,
      actorUserId: user.id,
      includeClosed
    });

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      conversations
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
