import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import {
  requireWorkspaceEnterprisePlan,
  requireWorkspacePermission
} from "@/platform/permissions";
import { getChatById, insertChatMessage } from "@/chat/repository";
import {
  getWorkspaceMemberByUser,
  isUserMemberOfQueue,
  touchQueueMemberLastAssigned
} from "@/agent/repository";
import { transferConversationToAgent } from "@/services/transfer";
import {
  broadcastAgentNotification,
  broadcastMessage,
  broadcastModeChange
} from "@/services/notification";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  target_agent_user_id: z.string().uuid(),
  target_queue_id: z.string().uuid().optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/supervisor/conversation/[id]/reassign
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = schema.safeParse(raw);

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

    const workspaceId = chat.workspace_id ?? chat.tenant_id;
    const { user } = await requireWorkspacePermission({
      token,
      workspaceId,
      permission: "conversation:supervise"
    });
    await requireWorkspaceEnterprisePlan({
      workspaceId,
      feature: "Supervisor reassignment controls"
    });

    await enforceAgentApiRateLimit(`supervisor_reassign:${getClientIp(request)}:${workspaceId}:${user.id}`);

    const targetMember = await getWorkspaceMemberByUser(workspaceId, parsed.data.target_agent_user_id);
    if (!targetMember || !targetMember.is_active || targetMember.role === "viewer") {
      throw new HttpError(404, "Target assignee is not an active workspace member");
    }

    if (parsed.data.target_queue_id) {
      const isQueueMember = await isUserMemberOfQueue(
        parsed.data.target_queue_id,
        parsed.data.target_agent_user_id
      );
      if (!isQueueMember) {
        throw new HttpError(409, "Target agent is not a member of the selected queue");
      }
    }

    const updated = await transferConversationToAgent({
      chatId,
      actorUserId: user.id,
      targetAgentUserId: parsed.data.target_agent_user_id,
      targetQueueId: parsed.data.target_queue_id
    });
    if (updated.queue_id) {
      await touchQueueMemberLastAssigned({
        queue_id: updated.queue_id,
        user_id: parsed.data.target_agent_user_id
      }).catch(() => undefined);
    }

    const systemMessage = await insertChatMessage({
      chat_id: chatId,
      role: "system",
      content: "Conversation was reassigned by a supervisor.",
      sender_type: "system",
      metadata: {
        reassigned_by: user.id,
        to_agent_id: parsed.data.target_agent_user_id,
        to_queue_id: parsed.data.target_queue_id ?? null
      }
    });

    await Promise.all([
      broadcastMessage(chatId, systemMessage),
      broadcastModeChange(chatId, updated.conversation_mode, {
        queue_id: updated.queue_id,
        agent_id: updated.assigned_agent_id,
        reason: "supervisor_reassign"
      }),
      broadcastAgentNotification(parsed.data.target_agent_user_id, "assignment", {
        chat_id: chatId,
        queue_id: updated.queue_id,
        mode: updated.conversation_mode,
        reason: "supervisor_reassign"
      }),
      writeAuditLog({
        workspaceId,
        actorUserId: user.id,
        action: "conversation.supervisor_reassign",
        targetType: "conversation",
        targetId: chatId,
        ipAddress: request.headers.get("x-forwarded-for"),
        metadata: {
          from_agent_id: chat.assigned_agent_id,
          to_agent_id: parsed.data.target_agent_user_id,
          to_queue_id: parsed.data.target_queue_id ?? null
        }
      })
    ]);

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: updated.conversation_mode,
      status: updated.conversation_status,
      assigned_agent_id: updated.assigned_agent_id,
      queue_id: updated.queue_id
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
