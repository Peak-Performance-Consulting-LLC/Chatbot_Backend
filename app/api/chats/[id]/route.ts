import { assertChatOwnership, deleteChatThread, renameChatThread } from "@/chat/repository";
import { deleteChatQuerySchema, patchChatInputSchema } from "@/chat/schemas";
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

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const payload = await request.json();
    const parsed = patchChatInputSchema.safeParse(payload);

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

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    await assertChatOwnership(context.params.id, parsed.data.tenant_id, parsed.data.device_id);

    const chat = await renameChatThread(context.params.id, parsed.data.title);
    return jsonCorsResponse(request, { chat });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const url = new URL(request.url);
    const parsed = deleteChatQuerySchema.safeParse({
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
    await deleteChatThread(context.params.id);

    return jsonCorsResponse(request, { ok: true });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
