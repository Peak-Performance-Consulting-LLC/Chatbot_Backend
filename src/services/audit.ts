import { logError } from "@/lib/logger";
import { insertAuditLog } from "@/platform/repository";

export async function writeAuditLog(input: {
  workspaceId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await insertAuditLog({
      workspace_id: input.workspaceId,
      actor_user_id: input.actorUserId ?? null,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      ip_address: input.ipAddress ?? null,
      metadata: input.metadata ?? {}
    });
  } catch (error) {
    logError("audit_log_write_failed", {
      workspace_id: input.workspaceId,
      actor_user_id: input.actorUserId,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
