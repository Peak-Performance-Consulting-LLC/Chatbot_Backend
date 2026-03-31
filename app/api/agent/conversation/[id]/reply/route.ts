import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";
import { getChatById, insertChatMessage, touchChatThread } from "@/chat/repository";
import { getModeTransitionMessage, transitionMode } from "@/services/conversation";
import { broadcastMessage, broadcastModeChange, broadcastWorkspaceInboxUpdate } from "@/services/notification";
import { writeAuditLog } from "@/services/audit";
import { recordFirstAgentResponse } from "@/services/sla";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replyBodySchema = z.object({
  content: z.string().trim().min(1).max(8000),
  is_internal: z.boolean().optional().default(false),
  client_message_id: z.string().trim().min(8).max(120).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/reply
 * Agent sends a message in a conversation.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);

    const raw = await request.json();
    const parsed = replyBodySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    // Verify the conversation exists and user can reply from shared inbox
    const chat = await getChatById(chatId);
    if (!chat) {
      throw new HttpError(404, "Conversation not found");
    }

    const workspaceId = chat.workspace_id ?? chat.tenant_id;
    const { user } = await requireWorkspaceResponderPermission({
      token,
      workspaceId,
      permission: "conversation:reply"
    });

    await enforceAgentApiRateLimit(`agent_reply:${getClientIp(request)}:${workspaceId}:${user.id}`);

    if (chat.conversation_mode === "closed" || chat.conversation_status === "closed") {
      throw new HttpError(409, "Cannot reply in a closed conversation.");
    }

    let conversation = chat;
    if (
      !parsed.data.is_internal &&
      chat.conversation_mode !== "agent_active" &&
      chat.conversation_mode !== "copilot"
    ) {
      const sourceMode = chat.conversation_mode ?? "ai_only";
      const transitioned = await transitionMode({
        chatId,
        toMode: "agent_active",
        actorId: user.id,
        actorType: "agent",
        eventType: "agent_takeover",
        metadata: {
          source_mode: sourceMode,
          agent_id: user.id
        },
        updates: {
          workspace_id: workspaceId,
          assigned_agent_id: user.id,
          assigned_at: new Date().toISOString()
        }
      });
      conversation = transitioned;

      const joinedMessage = getModeTransitionMessage("agent_active", user.full_name);
      if (joinedMessage) {
        const systemMessage = await insertChatMessage({
          chat_id: chatId,
          role: "system",
          content: joinedMessage,
          sender_type: "system",
          metadata: {
            mode_change: "agent_active",
            source_mode: sourceMode,
            agent_id: user.id,
            agent_name: user.full_name,
            agent_avatar_url: user.avatar_url
          }
        });
        await broadcastMessage(chatId, systemMessage).catch(() => undefined);
      }

      await broadcastModeChange(chatId, "agent_active", {
        source_mode: sourceMode,
        agent_id: user.id,
        agent_name: user.full_name,
        agent_avatar_url: user.avatar_url
      }).catch(() => undefined);

      await broadcastWorkspaceInboxUpdate(workspaceId, {
        chat_id: chatId,
        tenant_id: conversation.tenant_id,
        queue_id: conversation.queue_id ?? null,
        mode: "agent_active",
        reason: "agent_takeover",
        awaiting_agent_reply: false,
        waiting_age_seconds: null,
        waiting_urgency: null
      }).catch(() => undefined);
    }

    // Insert agent message
    const message = await insertChatMessage({
      chat_id: chatId,
      role: "assistant",
      content: parsed.data.content,
      sender_type: "agent",
      sender_id: user.id,
      is_internal: parsed.data.is_internal,
      dedupe_key: parsed.data.client_message_id
        ? `agent:${user.id}:${parsed.data.client_message_id.trim().toLowerCase()}`
        : null,
      metadata: {
        agent_id: user.id,
        agent_name: user.full_name,
        agent_avatar_url: user.avatar_url
      }
    });

    // Update thread timestamp and mark first response for SLA tracking
    await touchChatThread(chatId);
    if (!parsed.data.is_internal) {
      await recordFirstAgentResponse(conversation).catch(() => undefined);
    }

    // Broadcast to realtime subscribers (skip internal notes for widget)
    if (!parsed.data.is_internal) {
      await broadcastMessage(chatId, message);
      await broadcastWorkspaceInboxUpdate(workspaceId, {
        chat_id: chatId,
        tenant_id: conversation.tenant_id,
        queue_id: conversation.queue_id ?? null,
        mode: conversation.conversation_mode,
        reason: "agent_reply"
      }).catch(() => undefined);
    }
    await writeAuditLog({
      workspaceId,
      actorUserId: user.id,
      action: "conversation.agent_reply",
      targetType: "message",
      targetId: message.id,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        chat_id: chatId,
        is_internal: parsed.data.is_internal
      }
    });

    return jsonCorsResponse(request, {
      message
    }, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
