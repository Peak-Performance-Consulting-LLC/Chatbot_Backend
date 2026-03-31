import { getChatById, listChatMessages } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/agent/conversation/[id]/messages
 * Returns non-internal messages for an agent-visible conversation.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);
    const chat = await getChatById(chatId);

    if (!chat) {
      throw new HttpError(404, "Conversation not found");
    }

    const { role } = await requireWorkspaceResponderPermission({
      token,
      workspaceId: chat.workspace_id ?? chat.tenant_id,
      permission: "conversation:view"
    });

    const messages = await listChatMessages(chatId, { includeInternal: role !== "viewer" });
    return jsonCorsResponse(request, {
      chat_id: chatId,
      conversation: {
        id: chat.id,
        conversation_mode: chat.conversation_mode,
        conversation_status: chat.conversation_status,
        closed_at: chat.closed_at
      },
      messages
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
