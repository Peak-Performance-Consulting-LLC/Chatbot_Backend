import { z } from "zod";
import { assertChatOwnership } from "@/chat/repository";
import { optionsCorsResponse, jsonCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { createRealtimeEventStream } from "@/lib/realtimeStream";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventsQuerySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120)
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/conversation/[id]/events
 * Browser event stream fallback for conversation realtime events.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const url = new URL(request.url);
    const parsed = eventsQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      device_id: url.searchParams.get("device_id")
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request query", details: parsed.error.flatten() },
        400
      );
    }

    await assertTenantDomainAccess(request, parsed.data.tenant_id);
    const chat = await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);
    if (!chat) {
      throw new HttpError(404, "Conversation not found");
    }

    return createRealtimeEventStream(request, `conversation:${chatId}`);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
