import { getChatById, listChatMessages } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { isUserMemberOfQueue } from "@/agent/repository";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";

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

    const { user, role } = await requireWorkspacePermission({
      token,
      workspaceId: chat.workspace_id ?? chat.tenant_id,
      permission: "conversation:view"
    });

    if (role === "agent" && chat.assigned_agent_id !== user.id) {
      const isQueueVisible =
        chat.conversation_mode === "handoff_pending" &&
        Boolean(chat.queue_id) &&
        (await isUserMemberOfQueue(chat.queue_id!, user.id));
      if (!isQueueVisible) {
        throw new HttpError(403, "Agents can only view assigned or in-queue conversations");
      }
    }

    const messages = await listChatMessages(chatId, { includeInternal: role !== "viewer" });
    return jsonCorsResponse(request, { chat_id: chatId, messages });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
