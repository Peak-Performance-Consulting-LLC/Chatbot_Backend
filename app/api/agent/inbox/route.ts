import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { hasWorkspacePermission, isWorkspaceResponderRole } from "@/platform/permissions";
import { listUserTenantIds, listWorkspaceRolesForUser, resolvePlatformSession } from "@/platform/repository";
import { listAgentInboxConversations } from "@/agent/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/agent/inbox
 * Returns shared inbox conversations for owner/agent roles in readable workspaces.
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const user = await resolvePlatformSession(token);
    const [workspaceIds, roleMap] = await Promise.all([
      listUserTenantIds(user.id),
      listWorkspaceRolesForUser(user.id)
    ]);
    const readableWorkspaceIds = workspaceIds.filter((workspaceId) => {
      const role = roleMap.get(workspaceId) ?? "viewer";
      return (
        hasWorkspacePermission(role, "conversation:view") &&
        isWorkspaceResponderRole(role)
      );
    });
    if (readableWorkspaceIds.length === 0) {
      return jsonCorsResponse(
        request,
        { error: "Only owner or agent roles can access the shared inbox" },
        403
      );
    }
    const url = new URL(request.url);
    const requestedTenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    const scopedWorkspaceIds = requestedTenantId
      ? readableWorkspaceIds.filter((workspaceId) => workspaceId === requestedTenantId)
      : readableWorkspaceIds;

    if (requestedTenantId && scopedWorkspaceIds.length === 0) {
      return jsonCorsResponse(request, { error: "Workspace access denied" }, 403);
    }

    const inbox = await listAgentInboxConversations({
      user_id: user.id,
      workspace_ids: scopedWorkspaceIds
    });

    return jsonCorsResponse(request, {
      agent_id: user.id,
      conversations: inbox.conversations,
      my_active: inbox.my_active,
      queue_unassigned: inbox.queue_unassigned,
      waiting_count: inbox.waiting_count,
      answered_count: inbox.answered_count,
      high_waiting_count: inbox.high_waiting_count,
      critical_waiting_count: inbox.critical_waiting_count
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
