import { listRecentMessages } from "@/chat/repository";
import type { ChatMessage, MessageMetadata } from "@/chat/types";
import type { CallCta } from "@/flight/format";
import {
  generateGeminiText,
  streamGeminiReply,
  type GeminiUsageSummary
} from "@/llm/gemini";
import { AEROCONCIERGE_SYSTEM_PROMPT, RUNTIME_POLICY_APPENDIX } from "@/llm/prompts";
import { logError } from "@/lib/logger";
import { retrieveKnowledge } from "@/rag/retrieve";
import { buildServicesQuickReplies } from "@/travel/format";
import type { TravelService } from "@/travel/types";
import type { PlatformUsageEventResponseSource } from "@/platform/repository";

const HISTORY_LOAD_TIMEOUT_MS = 3000;
const KNOWLEDGE_RETRIEVAL_TIMEOUT_MS = 8000;
const LLM_STREAM_TIMEOUT_MS = 18000;
const LLM_FALLBACK_TIMEOUT_MS = 10000;
const KNOWLEDGE_MATCH_COUNT = 8;
const KNOWLEDGE_MAX_CHUNKS = 4;
const KNOWLEDGE_MAX_CONTEXT_CHARS = 2600;
const KNOWLEDGE_MIN_SIMILARITY = 0.2;

async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);

  try {
    return await factory(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${label} timed out after ${ms}ms`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toHistory(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
}

function buildRagUserPrompt(input: {
  retrievedContext: string;
  callNumber: string;
  callTel: string;
  userMessage: string;
  pageContext?: { url?: string; title?: string; content?: string };
}) {
  const contextBlock = input.retrievedContext
    ? `Knowledge Context:\n${input.retrievedContext}`
    : "Knowledge Context:\n(No context retrieved)";

  const pageBlock = input.pageContext
    ? `Page Context:\nURL: ${input.pageContext.url ?? "N/A"}\nTitle: ${input.pageContext.title ?? "N/A"}\nContent: ${
        input.pageContext.content ?? "N/A"
      }`
    : "Page Context:\nN/A";

  return [
    contextBlock,
    "",
    pageBlock,
    "",
    `Support call number: ${input.callNumber}`,
    `Support tel link: ${input.callTel}`,
    "",
    `User request:\n${input.userMessage}`
  ].join("\n");
}

function buildNoKnowledgeReply(callCta: CallCta) {
  return {
    text:
      `I don't have that detail in this website knowledge base yet. ` +
      `For immediate help, connect with a specialist: [${callCta.number}](${callCta.tel}).`,
    metadata: {
      no_rag_match: true,
      call_cta: callCta
    } as MessageMetadata
  };
}

export function isSimpleGreeting(message: string) {
  const normalized = message.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  return [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening"
  ].includes(normalized);
}

export function isSimpleGratitude(message: string) {
  const normalized = message.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  return ["thanks", "thank you", "thx"].includes(normalized);
}

export function isBusinessInfoIntent(message: string) {
  const normalized = message.trim().toLowerCase();
  return /(about(\s+the)?\s+(company|business|website)|about us|who are you|what do you do|company info|business info)/.test(
    normalized
  );
}

export function generateGreetingReply(input: {
  enabledServices: TravelService[];
  callCta: CallCta;
  message: string;
}): { text: string; metadata: MessageMetadata } {
  const isGratitude = isSimpleGratitude(input.message);
  const text = isGratitude
    ? "You're welcome. I can help with travel planning or support questions whenever you're ready."
    : "Hello. I can help with travel planning, flight deals, and website support. What would you like to do?";

  return {
    text,
    metadata: {
      call_cta: input.callCta,
      quick_replies: buildServicesQuickReplies(input.enabledServices)
    }
  };
}

export function generateBusinessInfoReply(input: {
  tenantName: string;
  businessDescription: string;
  enabledServices: TravelService[];
  callCta: CallCta;
}): { text: string; metadata: MessageMetadata } {
  const serviceLabel =
    input.enabledServices.length > 0 ? ` We help with ${input.enabledServices.join(", ")}.` : "";
  return {
    text: `${input.tenantName} is ${input.businessDescription}.${serviceLabel}`.trim(),
    metadata: {
      call_cta: input.callCta,
      quick_replies: buildServicesQuickReplies(input.enabledServices)
    }
  };
}

export function generatePaymentReply(callCta: CallCta): {
  text: string;
  metadata: MessageMetadata;
} {
  return {
    text: `For booking and payment support, please connect with a booking specialist by phone: [${callCta.number}](${callCta.tel}).`,
    metadata: {
      call_cta: callCta
    }
  };
}

export async function streamAIResponse(input: {
  chatId: string;
  tenantId: string;
  userMessage: string;
  callCta: CallCta;
  requestId: string;
  writeToken: (token: string) => void;
  pageContext?: { url?: string; title?: string; content?: string };
  loadHistory: boolean;
}): Promise<{
  text: string;
  metadata: MessageMetadata;
  usage: GeminiUsageSummary;
  ragMatch: boolean;
  responseSource: PlatformUsageEventResponseSource;
  hadResponseError: boolean;
}> {
  let retrievedContext = "";
  let sourceUrls: string[] = [];
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let hadResponseError = false;
  let usage: GeminiUsageSummary = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    source: "none"
  };

  const [retrievalResult, recentMessagesResult] = await Promise.allSettled([
    withTimeout(
      (signal) =>
        retrieveKnowledge({
          tenantId: input.tenantId,
          query: input.userMessage,
          matchCount: KNOWLEDGE_MATCH_COUNT,
          maxChunks: KNOWLEDGE_MAX_CHUNKS,
          maxContextChars: KNOWLEDGE_MAX_CONTEXT_CHARS,
          minSimilarity: KNOWLEDGE_MIN_SIMILARITY,
          signal
        }),
      KNOWLEDGE_RETRIEVAL_TIMEOUT_MS,
      "Knowledge retrieval"
    ),
    input.loadHistory
      ? withTimeout(
          (signal) => listRecentMessages(input.chatId, 6, { signal }),
          HISTORY_LOAD_TIMEOUT_MS,
          "Chat history load"
        )
      : Promise.resolve([] as ChatMessage[])
  ]);

  if (retrievalResult.status === "fulfilled") {
    retrievedContext = retrievalResult.value.contextText.trim();
    sourceUrls = retrievalResult.value.sourceUrls;
  } else {
    hadResponseError = true;
    logError("rag_retrieval_failed", {
      request_id: input.requestId,
      chat_id: input.chatId,
      tenant_id: input.tenantId,
      error:
        retrievalResult.reason instanceof Error
          ? retrievalResult.reason.message
          : String(retrievalResult.reason)
    });
  }

  if (recentMessagesResult.status === "fulfilled") {
    history = toHistory(recentMessagesResult.value).slice(0, -1);
  } else {
    hadResponseError = true;
    logError("chat_history_load_failed", {
      request_id: input.requestId,
      chat_id: input.chatId,
      tenant_id: input.tenantId,
      error:
        recentMessagesResult.reason instanceof Error
          ? recentMessagesResult.reason.message
          : String(recentMessagesResult.reason)
    });
  }

  const metadata: MessageMetadata = {
    call_cta: input.callCta,
    source_urls: sourceUrls,
    ...(retrievedContext ? {} : { no_rag_match: true })
  };

  if (!retrievedContext) {
    const fallback = buildNoKnowledgeReply(input.callCta);
    input.writeToken(fallback.text);
    return {
      text: fallback.text,
      metadata: { ...metadata, ...fallback.metadata },
      usage,
      ragMatch: false,
      responseSource: "fallback",
      hadResponseError
    };
  }

  let assistantText = "";
  let responseSource: PlatformUsageEventResponseSource = "llm";
  let allowStreamingTokens = true;

  try {
    const streamed = await withTimeout(
      (signal) =>
        streamGeminiReply({
          systemPrompt: `${AEROCONCIERGE_SYSTEM_PROMPT}\n\n${RUNTIME_POLICY_APPENDIX}`,
          retrievedContext: [
            retrievedContext,
            `Support call number: ${input.callCta.number}`,
            `Support tel link: ${input.callCta.tel}`
          ].join("\n"),
          pageContext: input.pageContext,
          history,
          userMessage: input.userMessage,
          signal,
          timeoutMs: LLM_STREAM_TIMEOUT_MS,
          onToken: (token) => {
            if (allowStreamingTokens) {
              input.writeToken(token);
            }
          }
        }),
      LLM_STREAM_TIMEOUT_MS,
      "LLM stream"
    );

    assistantText = streamed.text;
    usage = streamed.usage;

    if (!assistantText) {
      throw new Error("LLM stream returned empty text");
    }
  } catch (error) {
    allowStreamingTokens = false;
    hadResponseError = true;
    responseSource = "fallback";
    logError("llm_generation_failed", {
      request_id: input.requestId,
      chat_id: input.chatId,
      tenant_id: input.tenantId,
      error: error instanceof Error ? error.message : String(error)
    });

    const ragUserPrompt = buildRagUserPrompt({
      retrievedContext,
      callNumber: input.callCta.number,
      callTel: input.callCta.tel,
      userMessage: input.userMessage,
      pageContext: input.pageContext
    });

    try {
      const fallbackResult = await withTimeout(
        (signal) =>
          generateGeminiText(
            ragUserPrompt,
            `${AEROCONCIERGE_SYSTEM_PROMPT}\n\n${RUNTIME_POLICY_APPENDIX}`,
            {
              signal,
              timeoutMs: LLM_FALLBACK_TIMEOUT_MS
            }
          ),
        LLM_FALLBACK_TIMEOUT_MS,
        "LLM fallback"
      );

      assistantText = fallbackResult.text;
      usage = fallbackResult.usage;

      if (!assistantText) {
        throw new Error("LLM non-stream fallback returned empty text");
      }

      input.writeToken(assistantText);
    } catch (fallbackError) {
      logError("llm_generation_fallback_failed", {
        request_id: input.requestId,
        chat_id: input.chatId,
        tenant_id: input.tenantId,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });

      assistantText =
        `I'm unable to access support responses right now. ` +
        `Please try again shortly, or connect at [${input.callCta.number}](${input.callCta.tel}).`;
      input.writeToken(assistantText);
    }
  }

  return {
    text: assistantText,
    metadata,
    usage,
    ragMatch: true,
    responseSource,
    hadResponseError
  };
}
