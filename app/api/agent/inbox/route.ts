import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { hasWorkspacePermission } from "@/platform/permissions";
import { listUserTenantIds, listWorkspaceRolesForUser, resolvePlatformSession } from "@/platform/repository";
import { listAgentInboxConversations, listQueueIdsForUser } from "@/agent/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/agent/inbox
 * Returns conversations assigned to the current agent + unassigned handoff_pending ones.
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const user = await resolvePlatformSession(token);
    const [workspaceIds, roleMap] = await Promise.all([
      listUserTenantIds(user.id),
      listWorkspaceRolesForUser(user.id)
    ]);
    const readableWorkspaceIds = workspaceIds.filter((workspaceId) =>
      hasWorkspacePermission(roleMap.get(workspaceId) ?? "viewer", "conversation:view")
    );
    const url = new URL(request.url);
    const requestedTenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    const scopedWorkspaceIds = requestedTenantId
      ? readableWorkspaceIds.filter((workspaceId) => workspaceId === requestedTenantId)
      : readableWorkspaceIds;

    if (requestedTenantId && scopedWorkspaceIds.length === 0) {
      return jsonCorsResponse(request, { error: "Workspace access denied" }, 403);
    }

    const queueIdsByWorkspace = await Promise.all(
      scopedWorkspaceIds.map((workspaceId) => listQueueIdsForUser(workspaceId, user.id))
    );
    const queueIds = Array.from(new Set(queueIdsByWorkspace.flat()));

    const inbox = await listAgentInboxConversations({
      user_id: user.id,
      workspace_ids: scopedWorkspaceIds,
      queue_ids: queueIds
    });

    return jsonCorsResponse(request, {
      agent_id: user.id,
      conversations: [...inbox.my_active, ...inbox.queue_unassigned],
      my_active: inbox.my_active,
      queue_unassigned: inbox.queue_unassigned
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
