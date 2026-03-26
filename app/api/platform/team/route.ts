import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import {
  inviteWorkspaceMember,
  listWorkspaceInvitationsForActor,
  listWorkspaceMembers,
  updateWorkspaceMemberRole
} from "@/services/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inviteSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  role: z.enum(["owner", "admin", "supervisor", "agent", "viewer"]).optional()
});

const updateRoleSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  user_id: z.string().uuid(),
  role: z.enum(["owner", "admin", "supervisor", "agent", "viewer"])
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/platform/team?tenant_id=...
 * Lists active workspace members.
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
      permission: "workspace:read"
    });

    const members = await listWorkspaceMembers({
      workspaceId: tenantId,
      actorUserId: user.id
    });
    const invitations = await listWorkspaceInvitationsForActor({
      workspaceId: tenantId,
      actorUserId: user.id
    });

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      members,
      invitations
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * POST /api/platform/team
 * Creates a workspace invitation with role and tokenized accept flow.
 */
export async function POST(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = inviteSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: parsed.data.tenant_id,
      permission: "team:manage"
    });

    const invite = await inviteWorkspaceMember({
      workspaceId: parsed.data.tenant_id,
      actorUserId: user.id,
      email: parsed.data.email,
      role: parsed.data.role
    });

    return jsonCorsResponse(request, {
      tenant_id: parsed.data.tenant_id,
      invitation: invite.invitation,
      invite_url: invite.invite_url,
      invite_token: invite.invite_token
    }, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * PATCH /api/platform/team
 * Updates a workspace member's role.
 */
export async function PATCH(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = updateRoleSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: parsed.data.tenant_id,
      permission: "team:manage"
    });

    const member = await updateWorkspaceMemberRole({
      workspaceId: parsed.data.tenant_id,
      actorUserId: user.id,
      targetUserId: parsed.data.user_id,
      role: parsed.data.role
    });

    return jsonCorsResponse(request, {
      tenant_id: parsed.data.tenant_id,
      member
    }, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
