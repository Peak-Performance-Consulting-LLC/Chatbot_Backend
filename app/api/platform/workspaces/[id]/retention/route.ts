import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { platformRetentionPatchSchema } from "@/platform/schemas";
import {
  getTenantRetentionSettings,
  updateTenantRetentionSettings
} from "@/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/platform/workspaces/[id]/retention
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const token = parseBearerToken(request);
    const { id: tenantId } = await context.params;

    await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "workspace:read"
    });

    const settings = await getTenantRetentionSettings(tenantId);
    return jsonCorsResponse(request, { tenant_id: tenantId, retention: settings }, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * PATCH /api/platform/workspaces/[id]/retention
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const token = parseBearerToken(request);
    const { id: tenantId } = await context.params;
    const raw = await request.json();
    const parsed = platformRetentionPatchSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "workspace:admin"
    });

    const settings = await updateTenantRetentionSettings({
      tenant_id: tenantId,
      conversation_retention_days: parsed.data.conversation_retention_days,
      retention_purge_grace_days: parsed.data.retention_purge_grace_days,
      allow_conversation_export: parsed.data.allow_conversation_export
    });

    return jsonCorsResponse(request, { tenant_id: tenantId, retention: settings }, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

