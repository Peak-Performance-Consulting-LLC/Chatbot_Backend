import { embedText } from "@/llm/gemini";
import { logError, logInfo } from "@/lib/logger";

/**
 * Common question patterns used to pre-warm the embedding cache.
 * Run this on server startup or after knowledge ingestion to
 * eliminate cold-start embedding latency for frequent queries.
 */
const COMMON_QUERIES = [
  "What are your prices?",
  "What services do you offer?",
  "How do I contact support?",
  "What is your refund policy?",
  "Tell me about your company",
  "How do I book a flight?",
  "What are your working hours?",
  "Do you offer hotel booking?",
  "What payment methods do you accept?",
  "How can I cancel my booking?",
  "Do you have any deals?",
  "What destinations do you cover?",
  "How do I change my reservation?",
  "What is included in the package?",
  "Do you offer travel insurance?",
];

export async function warmEmbeddingCache(
  extraQueries?: string[]
): Promise<{ warmed: number; failed: number }> {
  const queries = [...COMMON_QUERIES, ...(extraQueries ?? [])];
  let warmed = 0;
  let failed = 0;

  // Process in batches of 5 to avoid rate limiting
  for (let i = 0; i < queries.length; i += 5) {
    const batch = queries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((query) => embedText(query, { timeoutMs: 8000 }))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        warmed += 1;
      } else {
        failed += 1;
      }
    }
  }

  logInfo("embedding_cache_warmed", { warmed, failed, total: queries.length });
  return { warmed, failed };
}
