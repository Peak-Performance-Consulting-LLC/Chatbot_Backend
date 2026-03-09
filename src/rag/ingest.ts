import { load } from "cheerio";
import { embedDocumentText } from "@/llm/gemini";
import { HttpError } from "@/lib/httpError";
import { logError, logInfo } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export type TenantSourceInput =
  | { source_type: "url"; source_value: string }
  | { source_type: "sitemap"; source_value: string }
  | { source_type: "faq" | "doc_text"; source_value: string };

type ParsedDoc = {
  source_url: string | null;
  title: string;
  text: string;
};

export type IngestTenantInput = {
  tenant_id: string;
  sources: TenantSourceInput[];
  replace?: boolean;
  max_sitemap_urls?: number;
  max_chunks?: number;
};

export type IngestTenantResult = {
  tenant_id: string;
  inserted_chunks: number;
  fetched_documents: number;
  skipped_documents: number;
  errors: string[];
};

function chunkText(input: string, maxChars = 1400, overlap = 200): string[] {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    const slice = text.slice(cursor, end).trim();
    if (slice) {
      chunks.push(slice);
    }

    if (end === text.length) {
      break;
    }

    cursor = Math.max(0, end - overlap);
  }

  return chunks;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AeroConciergeIngest/1.0",
      Accept: "text/html,application/xml,text/xml,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchSitemapUrls(sitemapUrl: string, maxUrls = 80): Promise<string[]> {
  const xml = await fetchText(sitemapUrl);
  const locs = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/gi))
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);

  return Array.from(new Set(locs)).slice(0, maxUrls);
}

function parseLdJsonStrings($: ReturnType<typeof load>): string[] {
  const values: string[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const queue: unknown[] = [parsed];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }

        if (typeof current === "string") {
          const cleaned = current.replace(/\s+/g, " ").trim();
          if (cleaned.length >= 8) {
            values.push(cleaned);
          }
          continue;
        }

        if (Array.isArray(current)) {
          queue.push(...current);
          continue;
        }

        if (typeof current === "object") {
          queue.push(...Object.values(current as Record<string, unknown>));
        }
      }
    } catch {
      // ignore invalid json-ld
    }
  });

  return values;
}

async function parseWebDocument(url: string): Promise<ParsedDoc> {
  const html = await fetchText(url);
  const $ = load(html);

  const ldJsonStrings = parseLdJsonStrings($);
  $("script, style, noscript, iframe").remove();

  const title = $("title").first().text().trim() || url;
  const bodyText = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim();

  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  const fullText = [bodyText, title, metaDescription, ...ldJsonStrings]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    source_url: url,
    title,
    text: fullText
  };
}

function uniqueByValue(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

async function resolveSourcesToDocs(
  sources: TenantSourceInput[],
  maxSitemapUrls: number
): Promise<{ docs: ParsedDoc[]; errors: string[] }> {
  const docs: ParsedDoc[] = [];
  const errors: string[] = [];

  const directUrls = uniqueByValue(
    sources
      .filter((source) => source.source_type === "url")
      .map((source) => source.source_value)
  );
  const sitemapUrls = uniqueByValue(
    sources
      .filter((source) => source.source_type === "sitemap")
      .map((source) => source.source_value)
  );
  const rawTextSources = sources.filter((source) => source.source_type === "faq" || source.source_type === "doc_text");

  for (const source of rawTextSources) {
    docs.push({
      source_url: null,
      title: source.source_type === "faq" ? "FAQ Import" : "Document Import",
      text: source.source_value.trim()
    });
  }

  const urls = new Set<string>(directUrls);

  for (const sitemap of sitemapUrls) {
    try {
      const items = await fetchSitemapUrls(sitemap, maxSitemapUrls);
      for (const item of items) {
        urls.add(item);
      }
    } catch (error) {
      errors.push(`Sitemap failed (${sitemap}): ${error instanceof Error ? error.message : String(error)}`);
      logError("platform_ingest_sitemap_failed", {
        sitemap,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const url of urls) {
    try {
      const doc = await parseWebDocument(url);
      if (doc.text.length < 60) {
        continue;
      }
      docs.push(doc);
    } catch (error) {
      errors.push(`URL failed (${url}): ${error instanceof Error ? error.message : String(error)}`);
      logError("platform_ingest_url_failed", {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { docs, errors };
}

export async function ingestKnowledgeForTenant(input: IngestTenantInput): Promise<IngestTenantResult> {
  const maxSitemapUrls = Math.max(1, input.max_sitemap_urls ?? 40);
  const maxChunks = Math.max(1, input.max_chunks ?? 500);

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("tenant_id")
    .eq("tenant_id", input.tenant_id)
    .maybeSingle();

  if (tenantError) {
    throw new HttpError(500, `Tenant lookup failed: ${tenantError.message}`);
  }

  if (!tenant?.tenant_id) {
    throw new HttpError(404, `Tenant '${input.tenant_id}' not found`);
  }

  if (input.replace) {
    const { error: clearError } = await supabaseAdmin
      .from("knowledge_chunks")
      .delete()
      .eq("tenant_id", input.tenant_id);

    if (clearError) {
      throw new HttpError(500, `Failed to clear existing chunks: ${clearError.message}`);
    }
  }

  const { docs, errors } = await resolveSourcesToDocs(input.sources, maxSitemapUrls);
  const seenChunks = new Set<string>();

  let insertedChunks = 0;
  let fetchedDocs = 0;

  for (const doc of docs) {
    const chunks = chunkText(doc.text);
    if (chunks.length === 0) {
      continue;
    }

    fetchedDocs += 1;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (insertedChunks >= maxChunks) {
        break;
      }

      const chunkTextValue = chunks[chunkIndex] ?? "";
      const signature = chunkTextValue.toLowerCase().replace(/\s+/g, " ").trim();
      if (!signature || seenChunks.has(signature)) {
        continue;
      }

      seenChunks.add(signature);

      try {
        const embedding = await embedDocumentText(chunkTextValue);
        const { error } = await supabaseAdmin.from("knowledge_chunks").insert({
          tenant_id: input.tenant_id,
          source_url: doc.source_url,
          title: doc.title,
          chunk_text: chunkTextValue,
          embedding,
          metadata: {
            chunk_index: chunkIndex,
            source_title: doc.title,
            ingested_at: new Date().toISOString()
          }
        });

        if (error) {
          errors.push(`Chunk insert failed: ${error.message}`);
        } else {
          insertedChunks += 1;
        }
      } catch (error) {
        errors.push(`Embedding failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (insertedChunks >= maxChunks) {
      break;
    }
  }

  const result: IngestTenantResult = {
    tenant_id: input.tenant_id,
    inserted_chunks: insertedChunks,
    fetched_documents: fetchedDocs,
    skipped_documents: Math.max(0, docs.length - fetchedDocs),
    errors
  };

  logInfo("platform_ingest_completed", result);
  return result;
}

