import { GoogleGenerativeAI } from "@google/generative-ai";
import { assertEnvVars, getEnv } from "@/config/env";

let genAI: GoogleGenerativeAI | null = null;

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
  });

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

export async function generateGeminiReply(input: GeminiChatInput): Promise<string> {
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
  });

  return response.response.text().trim();
}

export async function generateGeminiText(prompt: string, systemPrompt?: string): Promise<string> {
  const model = getGeminiClient().getGenerativeModel({
    model: getChatModelName(),
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {})
  });

  const response = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });

  return response.response.text().trim();
}

export async function embedText(text: string): Promise<number[]> {
  assertEnvVars(["GEMINI_API_KEY"]);
  const apiKey = getEnv().GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${getEmbeddingModelName()}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: { role: "user", parts: [{ text }] },
        outputDimensionality: 768
      })
    }
  );

  const json = (await response.json()) as {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };

  if (!response.ok || !json.embedding?.values) {
    throw new Error(json.error?.message || "Embedding request failed");
  }

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
