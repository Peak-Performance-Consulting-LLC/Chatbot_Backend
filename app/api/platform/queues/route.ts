import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { createWorkspaceQueue, listWorkspaceQueues } from "@/services/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createQueueSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(120),
  routing_mode: z.enum(["manual_accept", "auto_assign"]).optional(),
  routing_strategy: z.enum(["priority_least_active", "round_robin"]).optional(),
  is_vip_queue: z.boolean().optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/platform/queues?tenant_id=...
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const tenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    if (!tenantId) {
      return jsonCorsResponse(request, { error: "tenant_id is required" }, 400);
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "workspace:read"
    });

    const queues = await listWorkspaceQueues({
      workspaceId: tenantId,
      actorUserId: user.id
    });

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      queues
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

/**
 * POST /api/platform/queues
 */
export async function POST(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = createQueueSchema.safeParse(raw);

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

    const queue = await createWorkspaceQueue({
      workspaceId: parsed.data.tenant_id,
      actorUserId: user.id,
      name: parsed.data.name,
      routingMode: parsed.data.routing_mode,
      routingStrategy: parsed.data.routing_strategy,
      isVipQueue: parsed.data.is_vip_queue
    });

    return jsonCorsResponse(request, { queue }, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
