import { getChatById } from "@/chat/repository";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { createRealtimeEventStream } from "@/lib/realtimeStream";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspaceResponderPermission } from "@/platform/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/agent/conversation/[id]/events
 * Browser event stream fallback for agent-visible conversation realtime events.
 */
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

    return createRealtimeEventStream(request, `conversation:${chatId}`);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
