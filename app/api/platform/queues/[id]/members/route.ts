import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { addAgentToQueue, listQueueAgents } from "@/services/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addMemberSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  user_id: z.string().uuid(),
  priority: z.number().int().min(0).max(10_000).optional(),
  max_concurrent_chats: z.number().int().min(1).max(200).optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  handles_vip: z.boolean().optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/platform/queues/[id]/members?tenant_id=...
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: queueId } = await params;
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const tenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    if (!tenantId) {
      return jsonCorsResponse(request, { error: "tenant_id is required" }, 400);
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "queue:manage"
    });

    const members = await listQueueAgents({
      queueId,
      workspaceId: tenantId,
      actorUserId: user.id
    });

    return jsonCorsResponse(request, {
      queue_id: queueId,
      members
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * POST /api/platform/queues/[id]/members
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: queueId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = addMemberSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: parsed.data.tenant_id,
      permission: "queue:manage"
    });

    const queueMember = await addAgentToQueue({
      queueId,
      workspaceId: parsed.data.tenant_id,
      actorUserId: user.id,
      memberUserId: parsed.data.user_id,
      priority: parsed.data.priority,
      maxConcurrentChats: parsed.data.max_concurrent_chats,
      skills: parsed.data.skills,
      handlesVip: parsed.data.handles_vip
    });

    return jsonCorsResponse(request, { queue_member: queueMember }, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
