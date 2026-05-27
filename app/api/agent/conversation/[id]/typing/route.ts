import { z } from "zod";
import { getChatById, markAgentTypingActivity } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";
import { broadcastTypingIndicator } from "@/services/notification";
import { getConversationTypingState, getTypingPayloadFromTimestamp, recordTypingState } from "@/services/typingState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const typingBodySchema = z.object({
  is_typing: z.boolean()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

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

    await requireWorkspaceResponderPermission({
      token,
      workspaceId: chat.workspace_id ?? chat.tenant_id,
      permission: "conversation:view"
    });

    const realtimeTyping = await getConversationTypingState(chatId);
    return jsonCorsResponse(request, {
      chat_id: chatId,
      typing: {
        agent:
          realtimeTyping.agent ??
          getTypingPayloadFromTimestamp({
            conversationId: chat.id,
            actor: "agent",
            userId: chat.assigned_agent_id ?? "agent",
            userName: "Agent",
            timestamp: chat.last_agent_typing_at
          }),
        visitor:
          realtimeTyping.visitor ??
          getTypingPayloadFromTimestamp({
            conversationId: chat.id,
            actor: "visitor",
            userId: chat.device_id,
            userName: "Visitor",
            timestamp: chat.last_visitor_typing_at
          })
      }
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
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

    if (chat.conversation_mode === "closed" || chat.conversation_status === "closed") {
      throw new HttpError(409, "Typing indicators are not supported for closed conversations");
    }

    await recordTypingState({
      conversationId: chatId,
      actor: "agent",
      userId: user.id,
      userName: user.full_name,
      isTyping: parsed.data.is_typing
    });

    await markAgentTypingActivity(chatId, parsed.data.is_typing).catch(() => undefined);

    await broadcastTypingIndicator(chatId, {
      chat_id: chatId,
      conversationId: chatId,
      actor: "agent",
      user_id: user.id,
      userId: user.id,
      userName: user.full_name,
      is_typing: parsed.data.is_typing
    });

    return jsonCorsResponse(request, { ok: true });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
