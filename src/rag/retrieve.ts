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

  const contextText = chunks
    .map((chunk, index) => `[Chunk ${index + 1}] ${chunk.chunk_text}`)
    .join("\n\n");

  const sourceUrls = Array.from(new Set(chunks.map((chunk) => chunk.source_url).filter(Boolean))) as string[];

  return {
    contextText,
    chunks,
    sourceUrls
  };
}
