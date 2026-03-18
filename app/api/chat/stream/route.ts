import { buildChatTitleFromMessage } from "@/chat/title";
import {
  assertChatOwnership,
  createChatThread,
  insertChatMessage,
  listRecentMessages,
  touchChatThread
} from "@/chat/repository";
import type { ChatMessage, ChatThread, MessageIntent, MessageMetadata } from "@/chat/types";
import { chatStreamInputSchema } from "@/chat/schemas";
import { insertOpeningMessage } from "@/chat/opening";
import { formatFlightDealsMessage, buildCallCtaMetadata } from "@/flight/format";
import type { CallCta } from "@/flight/format";
import { detectFlightIntent, detectPaymentIntent } from "@/flight/intent";
import { extractIataCode } from "@/flight/normalize";
import { buildSerpPayload, searchFlightsByPayload, suggestAirports } from "@/flight/serpClient";
import { applyUserMessageToFlightState, isFlightStateComplete } from "@/flight/slotFilling";
import { clearFlightState, getFlightState, upsertFlightState } from "@/flight/stateStore";
import type { FlightSearchState } from "@/flight/types";
import { buildCollectingFlightUiMetadata, buildResultsFlightUiMetadata } from "@/flight/ui";
import { generateGeminiText, streamGeminiReply } from "@/llm/gemini";
import { AEROCONCIERGE_SYSTEM_PROMPT, RUNTIME_POLICY_APPENDIX } from "@/llm/prompts";
import { getBaseCorsHeaders, jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { HttpError, toHttpError } from "@/lib/httpError";
import { logError, logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rateLimit";
import { getClientIp, getRequestId } from "@/lib/request";
import { createSSEStream, streamTextInChunks } from "@/lib/sse";
import { retrieveKnowledge } from "@/rag/retrieve";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import {
  buildServiceCollectingMetadata,
  buildServiceCompletedMessage,
  buildServicesQuickReplies
} from "@/travel/format";
import {
  detectServiceIntent,
  detectServiceRestartIntent,
  detectServiceUpdateIntent
} from "@/travel/intent";
import { applyUserMessageToServiceState, getNextServiceSlot } from "@/travel/slotFilling";
import { completeServiceState, upsertServiceState } from "@/travel/stateStore";
import type { TravelService, TravelServiceState } from "@/travel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HISTORY_LOAD_TIMEOUT_MS = 3000;
const KNOWLEDGE_RETRIEVAL_TIMEOUT_MS = 8000;
const LLM_STREAM_TIMEOUT_MS = 18000;
const LLM_FALLBACK_TIMEOUT_MS = 10000;

function isFlightStateActive(state: FlightSearchState | null) {
  return Boolean(state && state.status !== "done" && state.status !== "completed");
}

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

function isSimpleGreeting(message: string) {
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

function isSimpleGratitude(message: string) {
  const normalized = message.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  return ["thanks", "thank you", "thx"].includes(normalized);
}

function isBusinessInfoIntent(message: string) {
  const normalized = message.trim().toLowerCase();
  return /(about(\s+the)?\s+(company|business|website)|about us|who are you|what do you do|company info|business info)/.test(
    normalized
  );
}

function buildGreetingReply(input: {
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

function buildBusinessDescriptionReply(input: {
  tenantName: string;
  businessDescription: string;
  enabledServices: TravelService[];
  callCta: CallCta;
}) {
  const serviceLabel =
    input.enabledServices.length > 0 ? ` We help with ${input.enabledServices.join(", ")}.` : "";
  return {
    text: `${input.tenantName} is ${input.businessDescription}.${serviceLabel}`.trim(),
    metadata: {
      call_cta: input.callCta,
      quick_replies: buildServicesQuickReplies(input.enabledServices)
    } as MessageMetadata
  };
}

function buildPaymentSupportMessage(callCta: CallCta) {
  return {
    text: `For booking and payment support, please connect with a booking specialist by phone: [${callCta.number}](${callCta.tel}).`,
    metadata: {
      call_cta: callCta
    } as MessageMetadata
  };
}

function buildNoKnowledgeMessage(callCta: CallCta) {
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

async function ensureChatThread(input: {
  chatId?: string;
  tenantId: string;
  deviceId: string;
  message: string;
}): Promise<ChatThread> {
  if (input.chatId) {
    return assertChatOwnership(input.chatId, input.tenantId, input.deviceId);
  }

  const chat = await createChatThread({
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    title: buildChatTitleFromMessage(input.message)
  });
  await insertOpeningMessage(chat.id, input.tenantId);

  return chat;
}

async function produceFlightReply(input: {
  chatId: string;
  tenantId: string;
  userMessage: string;
  state: FlightSearchState | null;
  callCta: CallCta;
  writeToken: (token: string) => void;
}): Promise<{ text: string; metadata?: MessageMetadata | null }> {
  const { state, updateNotes, responseHint } = applyUserMessageToFlightState(input.state, input.userMessage);

  if (!isFlightStateComplete(state)) {
    await upsertFlightState(input.chatId, input.tenantId, state);

    const acknowledgement = updateNotes.length > 0 ? "Perfect, noted." : "";
    const responseText = [acknowledgement, responseHint ?? "Please share the next flight detail."]
      .filter(Boolean)
      .join(" ")
      .trim();

    streamTextInChunks(responseText, input.writeToken);

    return {
      text: responseText,
      metadata: {
        ...buildCollectingFlightUiMetadata(state, input.userMessage),
        call_cta: input.callCta,
        flight_state_snapshot: state as unknown as Record<string, unknown>
      }
    };
  }

  const originIata = state.origin ? extractIataCode(state.origin) : null;
  if (!originIata) {
    const options = state.origin ? await suggestAirports(state.origin) : [];
    state.origin = undefined;
    state.status = "collecting";
    state.last_asked_slot = "origin";
    await upsertFlightState(input.chatId, input.tenantId, state);

    const suggestionCodes = options.slice(0, 3).map((item) => item.code).join(", ");
    const clarification = suggestionCodes
      ? `I found possible departure airports: ${suggestionCodes}. Please reply with the correct 3-letter code.`
      : "I couldn't match the departure airport. Please confirm the city or 3-letter airport code (example: JFK).";
    streamTextInChunks(clarification, input.writeToken);

    return {
      text: clarification,
      metadata: {
        ...buildCollectingFlightUiMetadata(state, input.userMessage),
        call_cta: input.callCta,
        flight_state_snapshot: state as unknown as Record<string, unknown>
      }
    };
  }

  const destinationIata = state.destination ? extractIataCode(state.destination) : null;
  if (!destinationIata) {
    const options = state.destination ? await suggestAirports(state.destination) : [];
    state.destination = undefined;
    state.status = "collecting";
    state.last_asked_slot = "destination";
    await upsertFlightState(input.chatId, input.tenantId, state);

    const suggestionCodes = options.slice(0, 3).map((item) => item.code).join(", ");
    const clarification = suggestionCodes
      ? `I found possible destination airports: ${suggestionCodes}. Please reply with the correct 3-letter code.`
      : "I couldn't match the destination airport. Please confirm the city or 3-letter airport code (example: LAX).";
    streamTextInChunks(clarification, input.writeToken);

    return {
      text: clarification,
      metadata: {
        ...buildCollectingFlightUiMetadata(state, input.userMessage),
        call_cta: input.callCta,
        flight_state_snapshot: state as unknown as Record<string, unknown>
      }
    };
  }

  const payload = buildSerpPayload({
    ...state,
    origin: originIata,
    destination: destinationIata
  });

  try {
    const { deals } = await searchFlightsByPayload(payload);
    const formatted = formatFlightDealsMessage(deals, input.callCta);
    streamTextInChunks(formatted.text, input.writeToken);

    await clearFlightState(input.chatId, input.tenantId);

    return {
      text: formatted.text,
      metadata: {
        ...formatted.metadata,
        flight_payload: payload,
        ...buildResultsFlightUiMetadata({ ...state, status: "done" }),
        flight_results: (formatted.metadata.flight_deals ?? []).map((deal) => {
          const rawMatch = deals.find((item) => item.id === deal.id);
          return rawMatch?.raw ?? {};
        }),
        flight_state_snapshot: { ...state, status: "done" } as Record<string, unknown>
      }
    };
  } catch (error) {
    await clearFlightState(input.chatId, input.tenantId);

    const message =
      `I couldn't fetch live fares right now. Please start again with your departure airport code, ` +
      `or connect directly at [${input.callCta.number}](${input.callCta.tel}).`;

    streamTextInChunks(message, input.writeToken);

    return {
      text: message,
      metadata: {
        call_cta: input.callCta,
        flight_payload: payload,
        flight_state_snapshot: { ...state, status: "done" } as Record<string, unknown>
      }
    };
  }
}

async function produceServiceReply(input: {
  chatId: string;
  tenantId: string;
  userMessage: string;
  enabledServices: TravelService[];
  callCta: CallCta;
  state: TravelServiceState | null;
  writeToken: (token: string) => void;
}): Promise<{ text: string; metadata: MessageMetadata }> {
  const detected = detectServiceIntent(input.userMessage, input.enabledServices);

  let activeService = input.state?.service ?? detected ?? null;
  if (!activeService) {
    const nonFlightServices = input.enabledServices.filter((service) => service !== "flights");
    const serviceNames = nonFlightServices.join(", ");
    const text =
      nonFlightServices.length > 0
        ? `I can help with ${serviceNames}. Which one would you like to plan first?`
        : "I can help with support questions for this website. You can also connect directly with a specialist.";
    streamTextInChunks(text, input.writeToken);
    return {
      text,
      metadata: {
        quick_replies: buildServicesQuickReplies(input.enabledServices),
        call_cta: input.callCta
      }
    };
  }

  if (
    input.state &&
    detected &&
    detected !== input.state.service &&
    detectServiceUpdateIntent(input.userMessage)
  ) {
    activeService = detected;
  }

  let currentState =
    input.state && activeService === input.state.service
      ? input.state
      : {
          service: activeService,
          status: "collecting" as const,
          slots: {}
        };

  if (detectServiceRestartIntent(input.userMessage)) {
    currentState = {
      service: activeService,
      status: "collecting",
      slots: {}
    };
  }

  const { state, updateNotes, responseHint } = applyUserMessageToServiceState(
    currentState,
    activeService,
    input.userMessage
  );

  const nextSlot = getNextServiceSlot(state);
  if (nextSlot) {
    await upsertServiceState(input.chatId, input.tenantId, state);
    const responseText = [updateNotes.join(" "), responseHint ?? nextSlot.question]
      .filter(Boolean)
      .join("\n")
      .trim();

    streamTextInChunks(responseText, input.writeToken);
    return {
      text: responseText,
      metadata: {
        ...buildServiceCollectingMetadata(state),
        call_cta: input.callCta,
        quick_replies: buildServicesQuickReplies(input.enabledServices)
      }
    };
  }

  await completeServiceState(input.chatId, input.tenantId, state);

  const completed = buildServiceCompletedMessage({
    state,
    callCta: input.callCta
  });
  const responseText = [updateNotes.join(" "), completed.text]
    .filter(Boolean)
    .join("\n")
    .trim();
  streamTextInChunks(responseText, input.writeToken);

  return {
    text: responseText,
    metadata: {
      ...completed.metadata,
      quick_replies: buildServicesQuickReplies(input.enabledServices)
    }
  };
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

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const raw = await request.json();
    const parsed = chatStreamInputSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid request payload",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const input = parsed.data;
    const ip = getClientIp(request);

    // Fix 1: Parallelize tenant auth + rate limit (saves ~500-800ms)
    const rateLimitKey = `${ip}:${input.device_id}:${input.tenant_id}`;
    const [tenant, rateLimit] = await Promise.all([
      assertTenantDomainAccess(request, input.tenant_id),
      enforceRateLimit(rateLimitKey)
    ]);

    if (!rateLimit.allowed) {
      return jsonCorsResponse(
        request,
        {
          error: "Rate limit exceeded. Please try again shortly.",
          retry_after_ms: Math.max(0, rateLimit.resetAt - Date.now())
        },
        429
      );
    }

    const callCta = buildCallCtaMetadata({
      number: tenant.support_phone,
      label: tenant.support_cta_label
    });

    const thread = await ensureChatThread({
      chatId: input.chat_id,
      tenantId: input.tenant_id,
      deviceId: input.device_id,
      message: input.message
    });
    const chatId = thread.id;

    // Run flight state lookup concurrently with intent detection prep
    const currentFlightState = await getFlightState(chatId);
    const requestIntent: MessageIntent = isSimpleGreeting(input.message) || isSimpleGratitude(input.message)
      ? "greeting"
      : detectPaymentIntent(input.message)
      ? "payment_support"
      : detectFlightIntent(input.message) || isFlightStateActive(currentFlightState)
        ? "flight_search"
        : "knowledge";

    // Fire user message insert without blocking the stream start
    const userMsgPromise = insertChatMessage({
      chat_id: chatId,
      role: "user",
      content: input.message,
      metadata: {
        intent: requestIntent,
        tenant_id: input.tenant_id,
        ...(currentFlightState
          ? {
              flight_state_snapshot: currentFlightState as unknown as Record<string, unknown>
            }
          : {})
      }
    }).catch((err) => logError("user_msg_insert_failed", {
      request_id: requestId,
      chat_id: chatId,
      error: err instanceof Error ? err.message : String(err)
    }));

    return createSSEStream(request, async (writer) => {
      let assistantText = "";
      let assistantMetadata: MessageMetadata | null = null;
      let assistantIntent: MessageIntent = requestIntent;

      try {
        const isFlight = requestIntent === "flight_search";

        if (isFlight) {
          assistantIntent = "flight_search";
          const response = await produceFlightReply({
            chatId,
            tenantId: input.tenant_id,
            userMessage: input.message,
            state: currentFlightState,
            callCta,
            writeToken: writer.token
          });

          assistantText = response.text;
          assistantMetadata = response.metadata ?? null;
        } else if (requestIntent === "payment_support") {
          assistantIntent = "payment_support";
          const payment = buildPaymentSupportMessage(callCta);
          assistantText = payment.text;
          assistantMetadata = payment.metadata;
          streamTextInChunks(assistantText, writer.token);
        } else if (requestIntent === "greeting") {
          assistantIntent = "greeting";
          const greeting = buildGreetingReply({
            enabledServices: tenant.supported_services,
            callCta,
            message: input.message
          });
          assistantText = greeting.text;
          assistantMetadata = greeting.metadata;
          streamTextInChunks(assistantText, writer.token);
        } else {
          assistantIntent = "knowledge";
          if (tenant.business_description && isBusinessInfoIntent(input.message)) {
            const company = buildBusinessDescriptionReply({
              tenantName: tenant.name?.trim() || tenant.bot_name,
              businessDescription: tenant.business_description,
              enabledServices: tenant.supported_services,
              callCta
            });
            assistantText = company.text;
            assistantMetadata = company.metadata;
            streamTextInChunks(assistantText, writer.token);
          } else {
          let retrievedContext = "";
          let sourceUrls: string[] = [];
          let history: Array<{ role: "user" | "assistant"; content: string }> = [];

          const [retrievalResult, recentMessagesResult] = await Promise.allSettled([
            withTimeout(
              (signal) =>
                retrieveKnowledge({
                  tenantId: input.tenant_id,
                  query: input.message,
                  matchCount: 4,
                  maxChunks: 3,
                  maxContextChars: 2200,
                  minSimilarity: 0.45,
                  signal
                }),
              KNOWLEDGE_RETRIEVAL_TIMEOUT_MS,
              "Knowledge retrieval"
            ),
            input.chat_id
              ? withTimeout(
                  (signal) => listRecentMessages(chatId, 6, { signal }),
                  HISTORY_LOAD_TIMEOUT_MS,
                  "Chat history load"
                )
              : Promise.resolve([] as ChatMessage[])
          ]);

          if (retrievalResult.status === "fulfilled") {
            retrievedContext = retrievalResult.value.contextText.trim();
            sourceUrls = retrievalResult.value.sourceUrls;
          } else {
            retrievedContext = "";
            sourceUrls = [];

            logError("rag_retrieval_failed", {
              request_id: requestId,
              chat_id: chatId,
              tenant_id: input.tenant_id,
              error:
                retrievalResult.reason instanceof Error
                  ? retrievalResult.reason.message
                  : String(retrievalResult.reason)
            });
          }

          if (recentMessagesResult.status === "fulfilled") {
            history = toHistory(recentMessagesResult.value).slice(0, -1);
          } else {
            logError("chat_history_load_failed", {
              request_id: requestId,
              chat_id: chatId,
              tenant_id: input.tenant_id,
              error:
                recentMessagesResult.reason instanceof Error
                  ? recentMessagesResult.reason.message
                  : String(recentMessagesResult.reason)
            });
          }

          assistantMetadata = {
            call_cta: callCta,
            source_urls: sourceUrls,
            ...(retrievedContext ? {} : { no_rag_match: true })
          };

          if (!retrievedContext) {
            const fallback = buildNoKnowledgeMessage(callCta);
            assistantText = fallback.text;
            assistantMetadata = {
              ...(assistantMetadata ?? {}),
              ...fallback.metadata
            };
            streamTextInChunks(assistantText, writer.token);
          } else {
            let allowStreamingTokens = true;
            try {
              assistantText = await withTimeout(
                (signal) =>
                  streamGeminiReply({
                    systemPrompt: `${AEROCONCIERGE_SYSTEM_PROMPT}\n\n${RUNTIME_POLICY_APPENDIX}`,
                    retrievedContext: [
                      retrievedContext,
                      `Support call number: ${callCta.number}`,
                      `Support tel link: ${callCta.tel}`
                    ].join("\n"),
                    pageContext: input.page_context,
                    history,
                    userMessage: input.message,
                    signal,
                    timeoutMs: LLM_STREAM_TIMEOUT_MS,
                    onToken: (token) => {
                      if (allowStreamingTokens) {
                        writer.token(token);
                      }
                    }
                  }),
                LLM_STREAM_TIMEOUT_MS,
                "LLM stream"
              );

              if (!assistantText) {
                const fallback = buildNoKnowledgeMessage(callCta);
                assistantText = fallback.text;
                assistantMetadata = {
                  ...(assistantMetadata ?? {}),
                  ...fallback.metadata
                };
                streamTextInChunks(assistantText, writer.token);
              }
            } catch (error) {
              allowStreamingTokens = false;
              logError("llm_generation_failed", {
                request_id: requestId,
                chat_id: chatId,
                tenant_id: input.tenant_id,
                error: error instanceof Error ? error.message : String(error)
              });

              const ragUserPrompt = buildRagUserPrompt({
                retrievedContext,
                callNumber: callCta.number,
                callTel: callCta.tel,
                userMessage: input.message,
                pageContext: input.page_context
              });

              try {
                assistantText = await withTimeout(
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

                if (!assistantText) {
                  throw new Error("LLM non-stream fallback returned empty text");
                }

                streamTextInChunks(assistantText, writer.token);
              } catch (fallbackError) {
                logError("llm_generation_fallback_failed", {
                  request_id: requestId,
                  chat_id: chatId,
                  tenant_id: input.tenant_id,
                  error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                });

                assistantText =
                  `I'm unable to access support responses right now. ` +
                  `Please try again shortly, or connect at [${callCta.number}](${callCta.tel}).`;
                assistantMetadata = {
                  call_cta: callCta
                };
                streamTextInChunks(assistantText, writer.token);
              }
            }
          }
        }
        }

        if (!assistantText) {
          throw new HttpError(500, "Assistant response is empty");
        }

        // Persist both sides of the exchange before signaling completion so the
        // follow-up message sync cannot overwrite the streamed reply with stale data.
        await userMsgPromise;

        try {
          await Promise.all([
            insertChatMessage({
              chat_id: chatId,
              role: "assistant",
              content: assistantText,
              metadata: {
                intent: assistantIntent,
                tenant_id: input.tenant_id,
                ...(assistantMetadata ?? {})
              }
            }),
            touchChatThread(chatId, {
              title: thread.title === "New chat" ? buildChatTitleFromMessage(input.message) : undefined
            })
          ]);
        } catch (err) {
          logError("post_response_save_failed", {
            request_id: requestId,
            chat_id: chatId,
            error: err instanceof Error ? err.message : String(err)
          });
        }

        writer.done({ chat_id: chatId });

        logInfo("chat_stream_completed", {
          request_id: requestId,
          chat_id: chatId,
          tenant_id: input.tenant_id,
          device_id: input.device_id,
          message_length: input.message.length
        });
      } catch (error) {
        const asHttpError = toHttpError(error);
        writer.error(asHttpError.message);

        logError("chat_stream_failed", {
          request_id: requestId,
          chat_id: chatId,
          error: asHttpError.message,
          status: asHttpError.status
        });
      }
    });
  } catch (error) {
    const asHttpError = toHttpError(error);

    logError("chat_stream_request_failed", {
      request_id: requestId,
      error: asHttpError.message,
      status: asHttpError.status
    });

    return new Response(
      JSON.stringify({
        error: asHttpError.message
      }),
      {
        status: asHttpError.status,
        headers: {
          "Content-Type": "application/json",
          ...getBaseCorsHeaders(request)
        }
      }
    );
  }
}
