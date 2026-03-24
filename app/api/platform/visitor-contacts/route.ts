import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { platformVisitorContactsQuerySchema } from "@/platform/schemas";
import { getPlatformVisitorContacts } from "@/platform/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const parsed = platformVisitorContactsQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      query: url.searchParams.get("query") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid visitor contacts query",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const result = await getPlatformVisitorContacts({
      token,
      tenant_id: parsed.data.tenant_id,
      query: parsed.data.query,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
