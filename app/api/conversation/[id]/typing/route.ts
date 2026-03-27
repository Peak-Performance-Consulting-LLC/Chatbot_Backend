import { z } from "zod";
import { assertChatOwnership } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import { broadcastTypingIndicator } from "@/services/notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const typingBodySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  is_typing: z.boolean()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/conversation/[id]/typing
 * Visitor typing indicator for live conversation modes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const raw = await request.json();
    const parsed = typingBodySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    const chat = await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);

    if (
      chat.conversation_mode !== "handoff_pending" &&
      chat.conversation_mode !== "agent_active" &&
      chat.conversation_mode !== "copilot"
    ) {
      throw new HttpError(409, "Typing indicators are only supported in live agent conversation modes");
    }

    await broadcastTypingIndicator(chatId, {
      chat_id: chatId,
      actor: "visitor",
      user_id: parsed.data.device_id,
      is_typing: parsed.data.is_typing
    });

    return jsonCorsResponse(request, { ok: true });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

