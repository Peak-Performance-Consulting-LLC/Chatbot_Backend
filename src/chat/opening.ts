import { insertChatMessage, touchChatThread } from "@/chat/repository";
import { getTenantById } from "@/tenants/verifyTenant";

function formatSupportedServices(services: Array<"flights" | "hotels" | "cars" | "cruises">) {
  const labels = services.map((service) => {
    if (service === "cars") {
      return "car rentals";
    }
    if (service === "cruises") {
      return "cruises";
    }
    if (service === "hotels") {
      return "hotel stays";
    }
    return "live flight deals";
  });

  if (labels.length === 0) {
    return "travel support";
  }

  if (labels.length === 1) {
    return labels[0] ?? "travel support";
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

const FALLBACK_OPENING_MESSAGE =
  "Welcome to AeroConcierge. I can help with live flight deals and travel support for this website. " +
  "You can type naturally, or use the guided planner to search step by step.";

async function resolveOpeningMessage(tenantId?: string) {
  if (!tenantId) {
    return FALLBACK_OPENING_MESSAGE;
  }

  try {
    const tenant = await getTenantById(tenantId);
    const welcome = tenant.welcome_message?.trim();
    if (welcome) {
      return welcome;
    }

    return `Welcome to ${tenant.name || tenant.bot_name}. I can help with ${formatSupportedServices(tenant.supported_services)} and support questions from this website.`;
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
