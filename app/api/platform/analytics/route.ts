import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { platformAnalyticsQuerySchema } from "@/platform/schemas";
import { getPlatformAnalytics } from "@/platform/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const parsed = platformAnalyticsQuerySchema.safeParse({
      range: url.searchParams.get("range") ?? undefined,
      tenant_id: url.searchParams.get("tenant_id") ?? undefined,
      timezone: url.searchParams.get("timezone") ?? undefined
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid analytics query",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const result = await getPlatformAnalytics({
      token,
      range: parsed.data.range,
      tenant_id: parsed.data.tenant_id,
      timezone: parsed.data.timezone
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
