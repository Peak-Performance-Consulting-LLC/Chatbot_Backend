import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { returnToAI, getModeTransitionMessage } from "@/services/conversation";
import { broadcastModeChange, broadcastMessage } from "@/services/notification";
import { getChatById, insertChatMessage } from "@/chat/repository";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/return-to-ai
 * Agent returns the conversation back to the AI assistant.
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
    const { user, role } = await requireWorkspacePermission({
      token,
      workspaceId,
      permission: "conversation:reply"
    });
    await enforceAgentApiRateLimit(`agent_return_to_ai:${getClientIp(request)}:${workspaceId}:${user.id}`);
    if (role === "agent" && chat.assigned_agent_id !== user.id) {
      throw new HttpError(403, "Only the assigned agent can return this conversation to AI");
    }

    // Transition to returned_to_ai
    const updated = await returnToAI(chatId, user.id);

    // Insert system message
    const systemMessage = getModeTransitionMessage("returned_to_ai");
    if (systemMessage) {
      const msg = await insertChatMessage({
        chat_id: chatId,
        role: "system",
        content: systemMessage,
        sender_type: "system",
        metadata: {
          mode_change: "returned_to_ai",
          agent_id: user.id
        }
      });
      await broadcastMessage(chatId, msg);
    }

    // Broadcast mode change
    await broadcastModeChange(chatId, "returned_to_ai");
    await writeAuditLog({
      workspaceId,
      actorUserId: user.id,
      action: "conversation.returned_to_ai",
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for")
    });

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: updated.conversation_mode,
      status: updated.conversation_status
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
