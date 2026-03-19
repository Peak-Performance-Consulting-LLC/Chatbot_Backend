import { GoogleGenAI } from "@google/genai";
import { assertEnvVars, getEnv } from "@/config/env";

let genAI: GoogleGenAI | null = null;
const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;
const EMBEDDING_CACHE_MAX_ENTRIES = 500;
const embeddingCache = new Map<string, { values: number[]; expiresAt: number }>();

type GeminiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type GeminiContentPart = {
  text: string;
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiContentPart[];
};

export type GeminiUsageSource = "provider" | "counted" | "estimated" | "none";

export type GeminiUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: GeminiUsageSource;
};

export type GeminiTextResult = {
  text: string;
  usage: GeminiUsageSummary;
};

const ZERO_USAGE: GeminiUsageSummary = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  source: "none"
};

function normalizeCacheKey(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function pruneExpiredEntries<T>(cache: Map<string, { expiresAt: number; values?: T } | { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function trimCache<T>(cache: Map<string, T>, maxEntries: number) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function getGeminiClient() {
  if (genAI) {
    return genAI;
  }

  assertEnvVars(["GEMINI_API_KEY"]);
  genAI = new GoogleGenAI({
    apiKey: getEnv().GEMINI_API_KEY
  });
  return genAI;
}

function getChatModelName(): string {
  return getEnv().GEMINI_CHAT_MODEL;
}

function getEmbeddingModelName(): string {
  return getEnv().GEMINI_EMBEDDING_MODEL;
}

function toGeminiConfig(systemPrompt?: string, input?: GeminiRequestOptions) {
  if (!systemPrompt && !input?.signal && typeof input?.timeoutMs !== "number") {
    return undefined;
  }

  return {
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
    ...(input?.signal ? { abortSignal: input.signal } : {}),
    ...(typeof input?.timeoutMs === "number"
      ? {
          httpOptions: {
            timeout: input.timeoutMs
          }
        }
      : {})
  };
}

function createAbortError(message: string, name: "AbortError" | "TimeoutError") {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createFetchAbortSignal(input?: GeminiRequestOptions): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!input?.signal && typeof input?.timeoutMs !== "number") {
    return {
      signal: undefined,
      cleanup() {}
    };
  }

  if (input?.signal && typeof input?.timeoutMs !== "number") {
    return {
      signal: input.signal,
      cleanup() {}
    };
  }

  const controller = new AbortController();
  const timeoutMs = input?.timeoutMs ?? 0;
  const timeoutId = setTimeout(() => {
    controller.abort(createAbortError("Request timed out", "TimeoutError"));
  }, timeoutMs);

  const parentSignal = input?.signal;
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason ?? createAbortError("Request aborted", "AbortError"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

function mapHistory(history: HistoryTurn[]) {
  return history.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  })) satisfies GeminiContent[];
}

type GeminiChatInput = {
  systemPrompt: string;
  retrievedContext: string;
  pageContext?: { url?: string; title?: string; content?: string };
  history: HistoryTurn[];
  userMessage: string;
};

function buildUserPrompt(input: GeminiChatInput): string {
  const contextBlock = input.retrievedContext
    ? `Knowledge Context:\n${input.retrievedContext}`
    : "Knowledge Context:\n(No context retrieved)";

  const pageBlock = input.pageContext
    ? `Page Context:\nURL: ${input.pageContext.url ?? "N/A"}\nTitle: ${input.pageContext.title ?? "N/A"}\nContent: ${
        input.pageContext.content ?? "N/A"
      }`
    : "Page Context:\nN/A";

  return `${contextBlock}\n\n${pageBlock}\n\nUser request:\n${input.userMessage}`;
}

function buildGeminiContents(input: GeminiChatInput): GeminiContent[] {
  return [
    ...mapHistory(input.history),
    {
      role: "user",
      parts: [{ text: buildUserPrompt(input) }]
    }
  ];
}

function buildPlainTextContents(prompt: string): GeminiContent[] {
  return [
    {
      role: "user",
      parts: [{ text: prompt }]
    }
  ];
}

function normalizeTokenCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

function usageFromProvider(metadata: {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
} | null | undefined): GeminiUsageSummary | null {
  if (!metadata) {
    return null;
  }

  const promptTokens = normalizeTokenCount(metadata.promptTokenCount);
  const completionTokens = normalizeTokenCount(metadata.candidatesTokenCount);
  const totalTokens = normalizeTokenCount(metadata.totalTokenCount);

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }

  const resolvedPromptTokens = promptTokens ?? 0;
  const resolvedCompletionTokens = completionTokens ?? 0;

  return {
    promptTokens: resolvedPromptTokens,
    completionTokens: resolvedCompletionTokens,
    totalTokens: totalTokens ?? resolvedPromptTokens + resolvedCompletionTokens,
    source: "provider"
  };
}

function estimateTokensForText(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimateTokensForContents(contents: GeminiContent[]) {
  return contents.reduce(
    (sum, item) =>
      sum +
      item.parts.reduce((partSum, part) => partSum + estimateTokensForText(part.text), 0),
    0
  );
}

async function countTokensForContents(
  contents: GeminiContent[],
  systemPrompt?: string,
  options?: GeminiRequestOptions
) {
  try {
    const result = await getGeminiClient().models.countTokens({
      model: getChatModelName(),
      contents,
      config: toGeminiConfig(systemPrompt, options)
    });

    return normalizeTokenCount(result.totalTokens);
  } catch {
    return null;
  }
}

async function resolveUsageSummary(input: {
  contents: GeminiContent[];
  responseText: string;
  providerUsage?: {
    promptTokenCount?: number | null;
    candidatesTokenCount?: number | null;
    totalTokenCount?: number | null;
  } | null;
  systemPrompt?: string;
  options?: GeminiRequestOptions;
}): Promise<GeminiUsageSummary> {
  const providerUsage = usageFromProvider(input.providerUsage);
  if (providerUsage) {
    return providerUsage;
  }

  const [countedPromptTokens, countedCompletionTokens] = await Promise.all([
    countTokensForContents(input.contents, input.systemPrompt, input.options),
    input.responseText.trim()
      ? countTokensForContents(
          [
            {
              role: "model",
              parts: [{ text: input.responseText }]
            }
          ],
          undefined,
          input.options
        )
      : Promise.resolve(0)
  ]);

  if (countedPromptTokens !== null && countedCompletionTokens !== null) {
    return {
      promptTokens: countedPromptTokens,
      completionTokens: countedCompletionTokens,
      totalTokens: countedPromptTokens + countedCompletionTokens,
      source: "counted"
    };
  }

  const estimatedPromptTokens = estimateTokensForContents(input.contents);
  const estimatedCompletionTokens = estimateTokensForText(input.responseText);
  const estimatedTotalTokens = estimatedPromptTokens + estimatedCompletionTokens;

  if (estimatedTotalTokens === 0) {
    return ZERO_USAGE;
  }

  return {
    promptTokens: estimatedPromptTokens,
    completionTokens: estimatedCompletionTokens,
    totalTokens: estimatedTotalTokens,
    source: "estimated"
  };
}

export async function streamGeminiReply(input: {
  systemPrompt: string;
  retrievedContext: string;
  pageContext?: { url?: string; title?: string; content?: string };
  history: HistoryTurn[];
  userMessage: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GeminiTextResult> {
  const contents = buildGeminiContents(input);
  const response = await getGeminiClient().models.generateContentStream({
    model: getChatModelName(),
    contents,
    config: toGeminiConfig(input.systemPrompt, input)
  });

  let fullText = "";
  let latestProviderUsage: {
    promptTokenCount?: number | null;
    candidatesTokenCount?: number | null;
    totalTokenCount?: number | null;
  } | null = null;

  for await (const chunk of response) {
    const token = chunk.text ?? "";
    if (!token) {
      latestProviderUsage = chunk.usageMetadata ?? latestProviderUsage;
      continue;
    }

    fullText += token;
    input.onToken(token);
    latestProviderUsage = chunk.usageMetadata ?? latestProviderUsage;
  }

  const text = fullText.trim();
  const usage = await resolveUsageSummary({
    contents,
    responseText: text,
    providerUsage: latestProviderUsage,
    systemPrompt: input.systemPrompt,
    options: input
  });

  return {
    text,
    usage
  };
}

export async function generateGeminiReply(
  input: GeminiChatInput & GeminiRequestOptions
): Promise<GeminiTextResult> {
  const contents = buildGeminiContents(input);
  const response = await getGeminiClient().models.generateContent({
    model: getChatModelName(),
    contents,
    config: toGeminiConfig(input.systemPrompt, input)
  });

  const text = (response.text ?? "").trim();
  const usage = await resolveUsageSummary({
    contents,
    responseText: text,
    providerUsage: response.usageMetadata,
    systemPrompt: input.systemPrompt,
    options: input
  });

  return {
    text,
    usage
  };
}

export async function generateGeminiText(
  prompt: string,
  systemPrompt?: string,
  options?: GeminiRequestOptions
): Promise<GeminiTextResult> {
  const contents = buildPlainTextContents(prompt);
  const response = await getGeminiClient().models.generateContent({
    model: getChatModelName(),
    contents,
    config: toGeminiConfig(systemPrompt, options)
  });

  const text = (response.text ?? "").trim();
  const usage = await resolveUsageSummary({
    contents,
    responseText: text,
    providerUsage: response.usageMetadata,
    systemPrompt,
    options
  });

  return {
    text,
    usage
  };
}

export async function embedText(text: string, options?: GeminiRequestOptions): Promise<number[]> {
  const cacheKey = normalizeCacheKey(text);
  const cached = embeddingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.values;
  }

  assertEnvVars(["GEMINI_API_KEY"]);
  const apiKey = getEnv().GEMINI_API_KEY;
  let response: Response;

  const { signal, cleanup } = createFetchAbortSignal(options);

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${getEmbeddingModelName()}:embedContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: { role: "user", parts: [{ text }] },
          outputDimensionality: 768
        }),
        signal
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Embedding request timed out");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Embedding request aborted");
    }
    throw error;
  } finally {
    cleanup();
  }

  const json = (await response.json()) as {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };

  if (!response.ok || !json.embedding?.values) {
    throw new Error(json.error?.message || "Embedding request failed");
  }

  pruneExpiredEntries(embeddingCache);
  embeddingCache.set(cacheKey, {
    values: json.embedding.values,
    expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS
  });
  trimCache(embeddingCache, EMBEDDING_CACHE_MAX_ENTRIES);

  return json.embedding.values;
}

export async function embedDocumentText(text: string): Promise<number[]> {
  return embedText(text);
}

export function getGeminiModelConfig() {
  return {
    chatModelName: getChatModelName(),
    embeddingModelName: getEmbeddingModelName()
  };
}
