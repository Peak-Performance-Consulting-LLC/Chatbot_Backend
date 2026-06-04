import { assertChatOwnership, insertChatMessage } from "@/chat/repository";
import { chatQuerySchema } from "@/chat/schemas";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { closeConversation } from "@/services/conversation";
import { broadcastModeChange, broadcastMessage } from "@/services/notification";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id: chatId } = await context.params;
    const raw = await request.json();
    const parsed = chatQuerySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);

    const closingMessage = await insertChatMessage({
      chat_id: chatId,
      role: "system",
      content: "This conversation has been closed. You can start a new chat anytime if you need more help.",
      sender_type: "system",
      metadata: {
        closed_by: "visitor_resolution_flow"
      }
    });
    const chat = await closeConversation(chatId, parsed.data.device_id, "visitor");

    await Promise.all([
      broadcastMessage(chatId, closingMessage),
      broadcastModeChange(chatId, "closed", {
        closed_at: chat.closed_at,
        reason: "visitor_resolution_flow"
      })
    ]);

    return jsonCorsResponse(request, {
      chat_id: chat.id,
      mode: chat.conversation_mode,
      status: chat.conversation_status,
      closed_at: chat.closed_at
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
