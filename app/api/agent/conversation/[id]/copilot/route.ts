import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";
import { getChatById, insertChatMessage } from "@/chat/repository";
import { generateCopilotDraft } from "@/services/copilot";
import { getModeTransitionMessage, setCopilotMode } from "@/services/conversation";
import { broadcastModeChange } from "@/services/notification";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const copilotSchema = z.object({
  action: z.enum(["enable", "disable", "draft"]).default("draft"),
  prompt: z.string().trim().min(1).max(4000).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/agent/conversation/[id]/copilot
 * enable/disable copilot mode or generate a draft response.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json().catch(() => ({}));
    const parsed = copilotSchema.safeParse(raw);

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
    const { user } = await requireWorkspaceResponderPermission({
      token,
      workspaceId,
      permission: "conversation:reply"
    });

    if (parsed.data.action === "enable" || parsed.data.action === "disable") {
      const enabled = parsed.data.action === "enable";
      const updated = await setCopilotMode({
        chatId,
        agentUserId: user.id,
        enabled
      });

      const modeMessage = getModeTransitionMessage(updated.conversation_mode);
      if (modeMessage) {
        await insertChatMessage({
          chat_id: chatId,
          role: "system",
          content: modeMessage,
          sender_type: "system",
          is_internal: true,
          metadata: {
            mode_change: updated.conversation_mode,
            copilot: true,
            actor_user_id: user.id
          }
        });
      }

      await Promise.all([
        broadcastModeChange(chatId, updated.conversation_mode, {
          queue_id: updated.queue_id,
          actor_user_id: user.id,
          copilot: true
        }),
        writeAuditLog({
          workspaceId,
          actorUserId: user.id,
          action: enabled ? "conversation.copilot_enabled" : "conversation.copilot_disabled",
          targetType: "conversation",
          targetId: chatId,
          ipAddress: request.headers.get("x-forwarded-for")
        })
      ]);

      return jsonCorsResponse(request, {
        chat_id: chatId,
        mode: updated.conversation_mode,
        status: updated.conversation_status
      });
    }

    if (chat.conversation_mode !== "copilot" && chat.conversation_mode !== "agent_active") {
      throw new HttpError(409, "Copilot draft is only available in active agent conversations");
    }

    const draft = await generateCopilotDraft({
      chatId,
      tenantId: chat.tenant_id,
      prompt: parsed.data.prompt
    });

    await writeAuditLog({
      workspaceId,
      actorUserId: user.id,
      action: "conversation.copilot_draft_generated",
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        response_source: draft.response_source,
        based_on_message_id: draft.based_on_message_id
      }
    });

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: chat.conversation_mode,
      draft
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
