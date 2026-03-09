import { insertChatMessage, touchChatThread } from "@/chat/repository";

const OPENING_MESSAGE =
  "Welcome to AeroConcierge. I can help with live flight deals and travel support for this website. " +
  "You can type naturally, or use the guided flight planner to search step by step.";

export async function insertOpeningMessage(chatId: string, tenantId?: string) {
  await insertChatMessage({
    chat_id: chatId,
    role: "assistant",
    content: OPENING_MESSAGE,
    metadata: {
      intent: "greeting",
      ...(tenantId ? { tenant_id: tenantId } : {})
    }
  });
  await touchChatThread(chatId);
}

export function getOpeningMessage() {
  return OPENING_MESSAGE;
}
