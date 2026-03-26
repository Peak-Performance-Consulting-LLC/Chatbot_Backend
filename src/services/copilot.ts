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
  prompt?: string;
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
  const latestVisitorMessage = [...recentMessages]
    .reverse()
    .find((message) => message.sender_type === "visitor" || message.role === "user");

  const userMessage = input.prompt?.trim() || latestVisitorMessage?.content?.trim();
  if (!userMessage) {
    throw new HttpError(400, "No visitor message available to draft a copilot response");
  }

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
    based_on_message_id: latestVisitorMessage?.id ?? null
  };
}
