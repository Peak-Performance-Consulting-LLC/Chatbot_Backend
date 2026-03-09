import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { platformTenantDomainSchema } from "@/platform/schemas";
import { updatePlatformTenantDomain } from "@/platform/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function PATCH(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformTenantDomainSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid request payload",
          details: parsed.error.flatten()
        },
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
