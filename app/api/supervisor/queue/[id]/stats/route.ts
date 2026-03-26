import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { getQueueById } from "@/agent/repository";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/supervisor/queue/[id]/stats?tenant_id=...
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

    await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "conversation:supervise"
    });

    const queue = await getQueueById(queueId);
    if (!queue || queue.workspace_id !== tenantId) {
      throw new HttpError(404, "Queue not found");
    }

    const { data, error } = await supabaseAdmin
      .from("chats")
      .select("id, conversation_mode, handoff_requested_at, sla_breached")
      .eq("queue_id", queueId)
      .eq("workspace_id", tenantId)
      .neq("conversation_status", "archived");

    if (error) {
      throw new HttpError(500, `Failed to load queue stats: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{
      id: string;
      conversation_mode: string;
      handoff_requested_at: string | null;
      sla_breached: boolean;
    }>;

    const now = Date.now();
    const pending = rows.filter((row) => row.conversation_mode === "handoff_pending");
    const active = rows.filter(
      (row) => row.conversation_mode === "agent_active" || row.conversation_mode === "copilot"
    );
    const closed = rows.filter((row) => row.conversation_mode === "closed");
    const breached = rows.filter((row) => row.sla_breached);

    const avgWaitSeconds =
      pending.length > 0
        ? Math.round(
            pending.reduce((sum, row) => {
              const ts = row.handoff_requested_at ? new Date(row.handoff_requested_at).getTime() : now;
              if (Number.isNaN(ts)) {
                return sum;
              }
              return sum + Math.max(0, Math.floor((now - ts) / 1000));
            }, 0) / pending.length
          )
        : 0;

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      queue_id: queueId,
      stats: {
        pending_count: pending.length,
        active_count: active.length,
        closed_count: closed.length,
        breached_count: breached.length,
        avg_wait_seconds: avgWaitSeconds
      }
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
