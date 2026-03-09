import { parseBearerToken } from "@/platform/auth";
import { platformTenantProfileSchema } from "@/platform/schemas";
import { updatePlatformTenantProfile } from "@/platform/service";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function PATCH(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformTenantProfileSchema.safeParse(raw);

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

    const result = await updatePlatformTenantProfile({
      token,
      tenant_id: parsed.data.tenant_id,
      business_type: parsed.data.business_type,
      supported_services: parsed.data.supported_services,
      support_phone: parsed.data.support_phone,
      support_email: parsed.data.support_email,
      support_cta_label: parsed.data.support_cta_label,
      business_description: parsed.data.business_description
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
