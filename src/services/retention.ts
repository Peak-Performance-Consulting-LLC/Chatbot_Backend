import { getEnv } from "@/config/env";
import { archiveExpiredClosedChats, deleteArchivedChats } from "@/chat/repository";
import { listAllTenantRetentionSettings } from "@/platform/repository";

function subtractDays(from: Date, days: number): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() - Math.max(0, days));
  return date.toISOString();
}

export async function runRetentionSweep(): Promise<{
  tenantsScanned: number;
  archivedConversations: number;
  purgedConversations: number;
}> {
  const env = getEnv();
  const policies = await listAllTenantRetentionSettings();
  const now = new Date();

  let archivedConversations = 0;
  let purgedConversations = 0;

  for (const policy of policies) {
    const archiveBefore = subtractDays(now, policy.settings.conversation_retention_days);
    archivedConversations += await archiveExpiredClosedChats({
      tenantId: policy.tenant_id,
      closedBefore: archiveBefore,
      limit: env.RETENTION_SWEEP_BATCH_SIZE
    });

    if (!env.RETENTION_PURGE_ENABLED) {
      continue;
    }

    const purgeBefore = subtractDays(
      now,
      policy.settings.conversation_retention_days + policy.settings.retention_purge_grace_days
    );
    purgedConversations += await deleteArchivedChats({
      tenantId: policy.tenant_id,
      archivedBefore: purgeBefore,
      limit: env.RETENTION_SWEEP_BATCH_SIZE
    });
  }

  return {
    tenantsScanned: policies.length,
    archivedConversations,
    purgedConversations
  };
}

