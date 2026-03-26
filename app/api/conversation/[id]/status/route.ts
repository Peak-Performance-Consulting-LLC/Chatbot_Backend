import { assertChatOwnership } from "@/chat/repository";
import { chatQuerySchema } from "@/chat/schemas";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/conversation/[id]/status
 * Returns the current conversation mode/status for reconnect fallback.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id: chatId } = await context.params;
    const url = new URL(request.url);
    const parsed = chatQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      device_id: url.searchParams.get("device_id")
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid query parameters", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    const chat = await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);

    return jsonCorsResponse(request, {
      chat_id: chat.id,
      mode: chat.conversation_mode ?? "ai_only",
      status: chat.conversation_status ?? "active",
      assigned_agent_id: chat.assigned_agent_id ?? null,
      workspace_id: chat.workspace_id ?? chat.tenant_id,
      queue_id: chat.queue_id ?? null,
      last_message_at: chat.last_message_at
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
