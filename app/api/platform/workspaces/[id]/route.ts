import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { deletePlatformWorkspace, updatePlatformTenantDomain } from "@/platform/service";
import { platformDeleteWorkspaceSchema, platformTenantDomainSchema } from "@/platform/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * PATCH /api/platform/workspaces/:id
 * Update tenant website domain (and re-generate DNS verification).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const token = parseBearerToken(request);
    const { id: tenantId } = await context.params;
    const raw = await request.json();

    const parsed = platformTenantDomainSchema.safeParse({ ...raw, tenant_id: tenantId });
    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const result = await updatePlatformTenantDomain({
      token,
      tenant_id: parsed.data.tenant_id,
      website_url: parsed.data.website_url
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * DELETE /api/platform/workspaces/:id
 * Delete a tenant and all associated data.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const token = parseBearerToken(request);
    const { id: tenantId } = await context.params;

    const parsed = platformDeleteWorkspaceSchema.safeParse({ tenant_id: tenantId });
    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid tenant ID", details: parsed.error.flatten() },
        400
      );
    }

    const result = await deletePlatformWorkspace({ token, tenant_id: parsed.data.tenant_id });
    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
