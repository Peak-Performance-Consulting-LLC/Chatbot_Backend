import { GoogleGenerativeAI } from "@google/generative-ai";
import { assertEnvVars, getEnv } from "@/config/env";

let genAI: GoogleGenerativeAI | null = null;
const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;
const EMBEDDING_CACHE_MAX_ENTRIES = 500;
const embeddingCache = new Map<string, { values: number[]; expiresAt: number }>();

type GeminiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
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
  genAI = new GoogleGenerativeAI(getEnv().GEMINI_API_KEY);
  return genAI;
}

function getChatModelName(): string {
  return getEnv().GEMINI_CHAT_MODEL;
}

function getEmbeddingModelName(): string {
  return getEnv().GEMINI_EMBEDDING_MODEL;
}

function toGeminiRequestOptions(input?: GeminiRequestOptions) {
  if (!input?.signal && typeof input?.timeoutMs !== "number") {
    return undefined;
  }

  return {
    ...(input?.signal ? { signal: input.signal } : {}),
    ...(typeof input?.timeoutMs === "number" ? { timeout: input.timeoutMs } : {})
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
  }));
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

export async function streamGeminiReply(input: {
  systemPrompt: string;
  retrievedContext: string;
  pageContext?: { url?: string; title?: string; content?: string };
  history: HistoryTurn[];
  userMessage: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const model = getGeminiClient().getGenerativeModel({
    model: getChatModelName(),
    systemInstruction: input.systemPrompt
  });

  const userPrompt = buildUserPrompt(input);

  const response = await model.generateContentStream({
    contents: [
      ...mapHistory(input.history),
      {
        role: "user",
        parts: [{ text: userPrompt }]
      }
    ]
  }, toGeminiRequestOptions(input));

  let fullText = "";
  for await (const chunk of response.stream) {
    const token = chunk.text();
    if (!token) {
      continue;
    }

    fullText += token;
    input.onToken(token);
  }

  return fullText.trim();
}

export async function generateGeminiReply(
  input: GeminiChatInput & GeminiRequestOptions
): Promise<string> {
  const model = getGeminiClient().getGenerativeModel({
    model: getChatModelName(),
    systemInstruction: input.systemPrompt
  });

  const userPrompt = buildUserPrompt(input);

  const response = await model.generateContent({
    contents: [
      ...mapHistory(input.history),
      {
        role: "user",
        parts: [{ text: userPrompt }]
      }
    ]
  }, toGeminiRequestOptions(input));

  return response.response.text().trim();
}

export async function generateGeminiText(
  prompt: string,
  systemPrompt?: string,
  options?: GeminiRequestOptions
): Promise<string> {
  const model = getGeminiClient().getGenerativeModel({
    model: getChatModelName(),
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {})
  });

  const response = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  }, toGeminiRequestOptions(options));

  return response.response.text().trim();
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
