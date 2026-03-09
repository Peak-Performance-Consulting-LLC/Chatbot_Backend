import { z } from "zod";
import { fetchPlaceSuggestions } from "@/flight/placeSuggestions";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  tenant_id: z.string().min(1),
  query: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(12).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      query: url.searchParams.get("query"),
      limit: url.searchParams.get("limit")
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

    await assertTenantDomainAccess(request, parsed.data.tenant_id);

    const suggestions = await fetchPlaceSuggestions(parsed.data.query, parsed.data.limit ?? 8);
    return jsonCorsResponse(request, { suggestions });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

