import { z } from "zod";
import { getChatById } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";
import { broadcastTypingIndicator } from "@/services/notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const typingBodySchema = z.object({
  is_typing: z.boolean()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/typing
 * Sends transient typing indicators to conversation realtime channel.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = typingBodySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const chat = await getChatById(chatId);
    if (!chat) {
      throw new HttpError(404, "Conversation not found");
    }

    const { user } = await requireWorkspaceResponderPermission({
      token,
      workspaceId: chat.workspace_id ?? chat.tenant_id,
      permission: "conversation:reply"
    });

    if (chat.conversation_mode !== "agent_active" && chat.conversation_mode !== "copilot") {
      throw new HttpError(409, "Typing indicators are only supported in active agent mode");
    }

    await broadcastTypingIndicator(chatId, {
      chat_id: chatId,
      actor: "agent",
      user_id: user.id,
      is_typing: parsed.data.is_typing
    });

    return jsonCorsResponse(request, { ok: true });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
