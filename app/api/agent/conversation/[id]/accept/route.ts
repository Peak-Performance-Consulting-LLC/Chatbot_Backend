import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";
import { acceptConversation, getModeTransitionMessage } from "@/services/conversation";
import { touchQueueMemberLastAssigned } from "@/agent/repository";
import {
  broadcastAgentNotification,
  broadcastModeChange,
  broadcastMessage,
  broadcastWorkspaceInboxUpdate
} from "@/services/notification";
import { getChatById, insertChatMessage } from "@/chat/repository";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/accept
 * Agent accepts a handoff_pending conversation.
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
    const { user } = await requireWorkspaceResponderPermission({
      token,
      workspaceId,
      permission: "conversation:accept"
    });

    await enforceAgentApiRateLimit(`agent_accept:${getClientIp(request)}:${workspaceId}:${user.id}`);

    // Transition to agent_active
    const updated = await acceptConversation(chatId, user.id);
    if (chat.queue_id) {
      await touchQueueMemberLastAssigned({
        queue_id: chat.queue_id,
        user_id: user.id
      }).catch(() => undefined);
    }

    // Insert system message visible to visitor
    const systemMessage = getModeTransitionMessage("agent_active", user.full_name);
    if (systemMessage) {
      const msg = await insertChatMessage({
        chat_id: chatId,
        role: "system",
        content: systemMessage,
        sender_type: "system",
        metadata: {
          mode_change: "agent_active",
          agent_id: user.id,
          agent_name: user.full_name,
          agent_avatar_url: user.avatar_url
        }
      });
      await broadcastMessage(chatId, msg);
    }

    // Broadcast mode change
    await broadcastModeChange(chatId, "agent_active", {
      agent_id: user.id,
      agent_name: user.full_name,
      agent_avatar_url: user.avatar_url,
      queue_id: chat.queue_id ?? null
    });
    await broadcastAgentNotification(user.id, "assignment", {
      chat_id: chatId,
      mode: "agent_active",
      queue_id: chat.queue_id ?? null
    });
    await broadcastWorkspaceInboxUpdate(workspaceId, {
      chat_id: chatId,
      tenant_id: chat.tenant_id,
      queue_id: chat.queue_id ?? null,
      mode: "agent_active",
      reason: "conversation_accepted"
    });
    await writeAuditLog({
      workspaceId,
      actorUserId: user.id,
      action: "conversation.accepted",
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        queue_id: chat.queue_id ?? null
      }
    });

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: updated.conversation_mode,
      status: updated.conversation_status,
      assigned_agent_id: updated.assigned_agent_id
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
