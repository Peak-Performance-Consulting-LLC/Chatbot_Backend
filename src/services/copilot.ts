import { randomUUID } from "node:crypto";
import { getChatById, listRecentMessages } from "@/chat/repository";
import type { MessageMetadata } from "@/chat/types";
import { buildCallCtaMetadata } from "@/flight/format";
import { HttpError } from "@/lib/httpError";
import { streamAIResponse } from "@/services/ai";
import { getTenantById } from "@/tenants/verifyTenant";

export async function generateCopilotDraft(input: {
  chatId: string;
  tenantId: string;
  guidance?: string;
  visitorMessageId?: string;
}): Promise<{
  draft: string;
  metadata: MessageMetadata;
  response_source: string;
  based_on_message_id: string | null;
}> {
  const chat = await getChatById(input.chatId);
  if (!chat) {
    throw new HttpError(404, "Conversation not found");
  }

  const recentMessages = await listRecentMessages(input.chatId, 30);
  const visitorMessages = recentMessages.filter(
    (message) => message.sender_type === "visitor" || message.role === "user"
  );
  const requestedVisitorMessage = input.visitorMessageId
    ? visitorMessages.find((message) => message.id === input.visitorMessageId)
    : null;
  const latestVisitorMessage = requestedVisitorMessage ?? [...visitorMessages]
    .reverse()
    .find((message) => message.content?.trim());

  const visitorMessage = latestVisitorMessage?.content?.trim();
  if (!latestVisitorMessage || !visitorMessage) {
    throw new HttpError(400, "No visitor message available to draft a copilot response");
  }

  const guidance = input.guidance?.trim();
  const userMessage = [
    "Draft a concise, helpful live-agent reply to the visitor message below.",
    "Base the reply on this visitor message. Do not answer unrelated guidance as if it came from the visitor.",
    "",
    `Visitor message: ${visitorMessage}`,
    guidance ? `Agent guidance: ${guidance}` : ""
  ].filter(Boolean).join("\n");

  const tenant = await getTenantById(input.tenantId);
  const callCta = buildCallCtaMetadata({
    number: tenant.support_phone,
    label: tenant.support_cta_label
  });

  const tokenBuffer: string[] = [];
  const result = await streamAIResponse({
    chatId: input.chatId,
    tenantId: input.tenantId,
    userMessage,
    callCta,
    requestId: `copilot_${randomUUID()}`,
    writeToken: (token) => {
      tokenBuffer.push(token);
    },
    loadHistory: true
  });

  return {
    draft: result.text,
    metadata: result.metadata,
    response_source: result.responseSource,
    based_on_message_id: latestVisitorMessage.id
  };
}
