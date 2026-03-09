import { assertChatOwnership, listChatMessages } from "@/chat/repository";
import { messagesQuerySchema } from "@/chat/schemas";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: { id: string };
};

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const url = new URL(request.url);
    const parsed = messagesQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      device_id: url.searchParams.get("device_id")
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
    await assertChatOwnership(context.params.id, parsed.data.tenant_id, parsed.data.device_id);

    const messages = await listChatMessages(context.params.id);
    return jsonCorsResponse(request, { messages });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
