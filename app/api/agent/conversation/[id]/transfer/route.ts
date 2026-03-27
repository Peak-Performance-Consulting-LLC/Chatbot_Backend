import { z } from "zod";
import { getChatById, insertChatMessage } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import {
  getWorkspaceMemberByUser,
  isUserMemberOfQueue,
  touchQueueMemberLastAssigned
} from "@/agent/repository";
import {
  broadcastAgentNotification,
  broadcastMessage,
  broadcastModeChange,
  broadcastQueueConversation,
  broadcastWorkspaceInboxUpdate
} from "@/services/notification";
import { transferConversationToAgent, transferConversationToQueue } from "@/services/transfer";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    target_agent_user_id: z.string().uuid().optional(),
    target_queue_id: z.string().uuid().optional()
  })
  .superRefine((value, ctx) => {
    if (!value.target_agent_user_id && !value.target_queue_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide target_agent_user_id and/or target_queue_id"
      });
    }
  });

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/transfer
 * Transfers a conversation to another agent or queue.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = bodySchema.safeParse(raw);

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
    const { user, role } = await requireWorkspacePermission({
      token,
      workspaceId,
      permission: "conversation:transfer"
    });

    await enforceAgentApiRateLimit(`agent_transfer:${getClientIp(request)}:${workspaceId}:${user.id}`);

    if (role === "agent" && chat.assigned_agent_id !== user.id) {
      throw new HttpError(403, "Agents can only transfer conversations assigned to them");
    }

    if (parsed.data.target_agent_user_id) {
      const targetMember = await getWorkspaceMemberByUser(workspaceId, parsed.data.target_agent_user_id);
      if (!targetMember || !targetMember.is_active) {
        throw new HttpError(404, "Target agent is not an active workspace member");
      }
      if (targetMember.role === "viewer") {
        throw new HttpError(409, "Target member cannot receive conversations");
      }
      if (parsed.data.target_queue_id) {
        const isInQueue = await isUserMemberOfQueue(
          parsed.data.target_queue_id,
          parsed.data.target_agent_user_id
        );
        if (!isInQueue) {
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
        content: "Conversation was transferred to another agent.",
        sender_type: "system",
        metadata: {
          mode_change: "agent_active",
          from_agent_id: chat.assigned_agent_id,
          to_agent_id: parsed.data.target_agent_user_id,
          to_queue_id: parsed.data.target_queue_id ?? null
        }
      });

      await Promise.all([
        broadcastMessage(chatId, systemMessage),
        broadcastModeChange(chatId, updated.conversation_mode, {
          queue_id: updated.queue_id ?? null,
          agent_id: updated.assigned_agent_id
        }),
        broadcastAgentNotification(parsed.data.target_agent_user_id, "assignment", {
          chat_id: chatId,
          mode: updated.conversation_mode,
          queue_id: updated.queue_id ?? null
        }),
        writeAuditLog({
          workspaceId,
          actorUserId: user.id,
          action: "conversation.transferred_to_agent",
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
      await broadcastWorkspaceInboxUpdate(workspaceId, {
        chat_id: chatId,
        tenant_id: chat.tenant_id,
        queue_id: updated.queue_id ?? null,
        mode: updated.conversation_mode,
        reason: "conversation_transferred_to_agent"
      });

      return jsonCorsResponse(request, {
        chat_id: chatId,
        mode: updated.conversation_mode,
        status: updated.conversation_status,
        assigned_agent_id: updated.assigned_agent_id,
        queue_id: updated.queue_id
      });
    }

    const updated = await transferConversationToQueue({
      chatId,
      actorUserId: user.id,
      targetQueueId: parsed.data.target_queue_id!
    });

    const systemMessage = await insertChatMessage({
      chat_id: chatId,
      role: "system",
      content: "Conversation was transferred to queue and is waiting for an agent.",
      sender_type: "system",
      metadata: {
        mode_change: "handoff_pending",
        to_queue_id: parsed.data.target_queue_id
      }
    });

    await Promise.all([
      broadcastMessage(chatId, systemMessage),
      broadcastModeChange(chatId, updated.conversation_mode, {
        queue_id: updated.queue_id ?? null
      }),
      broadcastQueueConversation(parsed.data.target_queue_id!, {
        chat_id: chatId,
        tenant_id: chat.tenant_id,
        mode: "handoff_pending",
        queue_id: parsed.data.target_queue_id!
      }),
      writeAuditLog({
        workspaceId,
        actorUserId: user.id,
        action: "conversation.transferred_to_queue",
        targetType: "conversation",
        targetId: chatId,
        ipAddress: request.headers.get("x-forwarded-for"),
        metadata: {
          from_agent_id: chat.assigned_agent_id,
          to_queue_id: parsed.data.target_queue_id
        }
      })
    ]);
    await broadcastWorkspaceInboxUpdate(workspaceId, {
      chat_id: chatId,
      tenant_id: chat.tenant_id,
      queue_id: updated.queue_id ?? null,
      mode: updated.conversation_mode,
      reason: "conversation_transferred_to_queue"
    });

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
