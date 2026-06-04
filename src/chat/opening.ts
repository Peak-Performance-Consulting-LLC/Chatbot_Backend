import { insertChatMessage, touchChatThread } from "@/chat/repository";
import { getTenantById } from "@/tenants/verifyTenant";

const FALLBACK_OPENING_MESSAGE =
  "Welcome to AeroConcierge. How can I help today?";

function isDealAvailabilityWelcome(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("deal") &&
    (normalized.includes("flight") || normalized.includes("hotel") || normalized.includes("booking"))
  ) || normalized.includes("hotel and flight deals are not shown");
}

async function resolveOpeningMessage(tenantId?: string) {
  if (!tenantId) {
    return FALLBACK_OPENING_MESSAGE;
  }

  try {
    const tenant = await getTenantById(tenantId);
    const welcome = tenant.welcome_message?.trim();
    if (welcome && !isDealAvailabilityWelcome(welcome)) {
      return welcome;
    }

    return `Welcome to ${tenant.name || tenant.bot_name}. How can I help today?`;
  } catch {
    return FALLBACK_OPENING_MESSAGE;
  }
}

export async function insertOpeningMessage(chatId: string, tenantId?: string) {
  const content = await resolveOpeningMessage(tenantId);

  await insertChatMessage({
    chat_id: chatId,
    role: "assistant",
    content,
    metadata: {
      intent: "greeting",
      ...(tenantId ? { tenant_id: tenantId } : {})
    }
  });
  await touchChatThread(chatId);
}

export function getOpeningMessage() {
  return FALLBACK_OPENING_MESSAGE;
}
