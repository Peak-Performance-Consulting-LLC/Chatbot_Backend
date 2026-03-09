import { parseBearerToken } from "@/platform/auth";
import { platformVerifyDomainSchema } from "@/platform/schemas";
import { verifyTenantDomain } from "@/platform/service";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function POST(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformVerifyDomainSchema.safeParse(raw);

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

    const result = await verifyTenantDomain({
      token,
      tenant_id: parsed.data.tenant_id
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

