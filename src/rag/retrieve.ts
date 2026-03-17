import { embedText } from "@/llm/gemini";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";

type MatchRow = {
  id: string;
  chunk_text: string;
  source_url: string | null;
  similarity: number;
};

const RETRIEVAL_CACHE_TTL_MS = 3 * 60 * 1000;
const RETRIEVAL_CACHE_MAX_ENTRIES = 150;
const retrievalCache = new Map<
  string,
  {
    value: { contextText: string; chunks: MatchRow[]; sourceUrls: string[] };
    expiresAt: number;
  }
>();

function normalizeQuery(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildRetrievalCacheKey(input: {
  tenantId: string;
  query: string;
  matchCount?: number;
  maxChunks?: number;
  maxContextChars?: number;
  minSimilarity?: number;
}) {
  return [
    input.tenantId,
    normalizeQuery(input.query),
    input.matchCount ?? 7,
    input.maxChunks ?? 4,
    input.maxContextChars ?? 2800,
    input.minSimilarity ?? 0
  ].join("::");
}

function pruneExpiredEntries() {
  const now = Date.now();
  for (const [key, value] of retrievalCache.entries()) {
    if (value.expiresAt <= now) {
      retrievalCache.delete(key);
    }
  }
}

function trimCache() {
  while (retrievalCache.size > RETRIEVAL_CACHE_MAX_ENTRIES) {
    const oldestKey = retrievalCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    retrievalCache.delete(oldestKey);
  }
}

export async function retrieveKnowledge(input: {
  tenantId: string;
  query: string;
  matchCount?: number;
  maxChunks?: number;
  maxContextChars?: number;
  minSimilarity?: number;
  signal?: AbortSignal;
}): Promise<{ contextText: string; chunks: MatchRow[]; sourceUrls: string[] }> {
  const cacheKey = buildRetrievalCacheKey(input);
  const cached = retrievalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const embedding = await embedText(input.query, {
    signal: input.signal,
    timeoutMs: 6000
  });

  const query = supabaseAdmin.rpc("match_knowledge_chunks", {
    query_embedding: embedding,
    match_count: input.matchCount ?? 7,
    tenant: input.tenantId
  });

  if (input.signal) {
    query.abortSignal(input.signal);
  }

  const { data, error } = await query;

  if (error) {
    throw new HttpError(500, `Knowledge retrieval failed: ${error.message}`);
  }

  const chunks = (data ?? []) as MatchRow[];
  const maxChunks = input.maxChunks ?? 4;
  const maxContextChars = input.maxContextChars ?? 2800;
  const minSimilarity = input.minSimilarity ?? 0;

  const selected: MatchRow[] = [];
  let usedChars = 0;

  for (const chunk of chunks) {
    if (selected.length >= maxChunks) {
      break;
    }

    if (chunk.similarity < minSimilarity) {
      continue;
    }

    const normalizedText = chunk.chunk_text.replace(/\s+/g, " ").trim();
    const remaining = maxContextChars - usedChars;
    if (!normalizedText || remaining <= 40) {
      break;
    }

    const excerpt =
      normalizedText.length <= remaining
        ? normalizedText
        : `${normalizedText.slice(0, Math.max(remaining - 3, 0)).trimEnd()}...`;

    selected.push({
      ...chunk,
      chunk_text: excerpt
    });
    usedChars += excerpt.length;
  }

  const contextText = selected
    .map((chunk, index) => `[Chunk ${index + 1}] ${chunk.chunk_text}`)
    .join("\n\n");

  const sourceUrls = Array.from(new Set(selected.map((chunk) => chunk.source_url).filter(Boolean))) as string[];

  const result = {
    contextText,
    chunks: selected,
    sourceUrls
  };

  pruneExpiredEntries();
  retrievalCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + RETRIEVAL_CACHE_TTL_MS
  });
  trimCache();

  return result;
}
