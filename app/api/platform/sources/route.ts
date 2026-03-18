import { parseBearerToken } from "@/platform/auth";
import {
  platformTenantSourcesQuerySchema,
  platformTenantSourcesSchema
} from "@/platform/schemas";
import {
  getTenantSourcesForUser,
  replaceTenantSourcesForUser
} from "@/platform/service";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const parsed = platformTenantSourcesQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id")
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid query parameters",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const result = await getTenantSourcesForUser({
      token,
      tenant_id: parsed.data.tenant_id
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

export async function PUT(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformTenantSourcesSchema.safeParse(raw);

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

    const result = await replaceTenantSourcesForUser({
      token,
      tenant_id: parsed.data.tenant_id,
      sources: parsed.data.sources
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
