import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { closeConversation } from "@/services/conversation";
import { broadcastMessage, broadcastModeChange } from "@/services/notification";
import { getChatById, insertChatMessage } from "@/chat/repository";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/supervisor/conversation/[id]/force-close
 */
export async function POST(
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

    const workspaceId = chat.workspace_id ?? chat.tenant_id;
    const { user } = await requireWorkspacePermission({
      token,
      workspaceId,
      permission: "conversation:supervise"
    });

    await enforceAgentApiRateLimit(`supervisor_force_close:${getClientIp(request)}:${workspaceId}:${user.id}`);

    const updated = await closeConversation(chatId, user.id, "supervisor");

    const systemMessage = await insertChatMessage({
      chat_id: chatId,
      role: "system",
      content: "Conversation closed by supervisor.",
      sender_type: "system",
      metadata: {
        mode_change: "closed",
        closed_by: user.id,
        closed_by_role: "supervisor"
      }
    });

    await Promise.all([
      broadcastMessage(chatId, systemMessage),
      broadcastModeChange(chatId, "closed", {
        queue_id: updated.queue_id,
        closed_by: user.id,
        reason: "supervisor_force_close"
      }),
      writeAuditLog({
        workspaceId,
        actorUserId: user.id,
        action: "conversation.supervisor_force_closed",
        targetType: "conversation",
        targetId: chatId,
        ipAddress: request.headers.get("x-forwarded-for"),
        metadata: {
          queue_id: updated.queue_id
        }
      })
    ]);

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: updated.conversation_mode,
      status: updated.conversation_status,
      closed_at: updated.closed_at
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
