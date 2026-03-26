import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { updateWorkspaceQueue } from "@/services/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(120).optional(),
  routing_mode: z.enum(["manual_accept", "auto_assign"]).optional(),
  routing_strategy: z.enum(["priority_least_active", "round_robin"]).optional(),
  is_active: z.boolean().optional(),
  is_vip_queue: z.boolean().optional(),
  business_hours: z.record(z.string(), z.unknown()).optional(),
  after_hours_action: z.enum(["collect_info", "overflow", "ai_only"]).optional(),
  overflow_queue_id: z.string().uuid().nullable().optional(),
  sla_first_response_seconds: z.number().int().min(0).max(86_400).optional(),
  sla_warning_seconds: z.number().int().min(0).max(86_400).optional(),
  overflow_after_seconds: z.number().int().min(0).max(172_800).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * PATCH /api/platform/queues/[id]
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: queueId } = await params;
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = patchSchema.safeParse(raw);

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

    const queue = await updateWorkspaceQueue({
      queueId,
      workspaceId: parsed.data.tenant_id,
      actorUserId: user.id,
      name: parsed.data.name,
      routingMode: parsed.data.routing_mode,
      routingStrategy: parsed.data.routing_strategy,
      isActive: parsed.data.is_active,
      isVipQueue: parsed.data.is_vip_queue,
      businessHours: parsed.data.business_hours,
      afterHoursAction: parsed.data.after_hours_action,
      overflowQueueId: parsed.data.overflow_queue_id,
      slaFirstResponseSeconds: parsed.data.sla_first_response_seconds,
      slaWarningSeconds: parsed.data.sla_warning_seconds,
      overflowAfterSeconds: parsed.data.overflow_after_seconds
    });

    return jsonCorsResponse(request, { queue });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
