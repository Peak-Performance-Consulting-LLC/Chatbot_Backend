import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import {
  assertChatOwnership,
  getChatById,
  getConversationCsat,
  upsertConversationCsat
} from "@/chat/repository";
import { writeAuditLog } from "@/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120)
});

const submitSchema = querySchema.extend({
  rating: z.number().int().min(1).max(5),
  feedback: z.string().trim().max(2000).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/conversation/[id]/csat?tenant_id=...&device_id=...
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id") ?? undefined,
      device_id: url.searchParams.get("device_id") ?? undefined
    });
    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid query params", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);
    const csat = await getConversationCsat(chatId);

    return jsonCorsResponse(request, {
      chat_id: chatId,
      csat
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * POST /api/conversation/[id]/csat
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const raw = await request.json();
    const parsed = submitSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    const chat = await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);
    if (chat.conversation_mode !== "closed") {
      return jsonCorsResponse(
        request,
        { error: "CSAT can only be submitted after the conversation is closed." },
        409
      );
    }

    const csat = await upsertConversationCsat({
      chat_id: chatId,
      tenant_id: parsed.data.tenant_id,
      workspace_id: chat.workspace_id ?? chat.tenant_id,
      rating: parsed.data.rating,
      feedback: parsed.data.feedback,
      submitted_by: "visitor"
    });

    await writeAuditLog({
      workspaceId: chat.workspace_id ?? chat.tenant_id,
      actorUserId: null,
      action: "conversation.csat_submitted",
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        rating: csat.rating
      }
    }).catch(() => undefined);

    return jsonCorsResponse(request, {
      chat_id: chatId,
      csat
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

