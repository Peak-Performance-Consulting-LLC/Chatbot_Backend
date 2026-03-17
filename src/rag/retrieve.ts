import { embedText } from "@/llm/gemini";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";

type MatchRow = {
  id: string;
  chunk_text: string;
  source_url: string | null;
  similarity: number;
};

export async function retrieveKnowledge(input: {
  tenantId: string;
  query: string;
  matchCount?: number;
  maxChunks?: number;
  maxContextChars?: number;
  minSimilarity?: number;
}): Promise<{ contextText: string; chunks: MatchRow[]; sourceUrls: string[] }> {
  const embedding = await embedText(input.query);

  const { data, error } = await supabaseAdmin.rpc("match_knowledge_chunks", {
    query_embedding: embedding,
    match_count: input.matchCount ?? 7,
    tenant: input.tenantId
  });

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

  return {
    contextText,
    chunks: selected,
    sourceUrls
  };
}
