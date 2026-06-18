import { load } from "cheerio";
import { embedDocumentText } from "@/llm/gemini";
import { HttpError } from "@/lib/httpError";
import { logError, logInfo } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export type TenantSourceInput =
  | { source_type: "url"; source_value: string; source_id?: string }
  | { source_type: "sitemap"; source_value: string; source_id?: string }
  | { source_type: "faq" | "doc_text"; source_value: string; source_id?: string };

type ResolvedSource = TenantSourceInput & {
  source_host: string | null;
};

type ParsedDoc = {
  source_url: string | null;
  title: string;
  text: string;
  source: ResolvedSource;
};

type ParsedDocumentContent = Omit<ParsedDoc, "source">;

type FetchTextResult = {
  text: string;
  contentType: string | null;
};

type ChunkJob = {
  doc: ParsedDoc;
  chunk_index: number;
  chunk_text: string;
};

const LEAKED_API_KEY_PHRASE = "api key was reported as leaked";

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

const DOCUMENT_FETCH_CONCURRENCY = 6;
const CHUNK_INGEST_CONCURRENCY = 4;

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
      }
    })
  );

  return results;
}

function normalizeDocumentText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function isLeakedEmbeddingKeyError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes(LEAKED_API_KEY_PHRASE);
}

function getUrlHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getFetchCause(error: Error) {
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause && typeof cause === "object" ? (cause as Record<string, unknown>) : null;
}

function formatFetchError(url: string, error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const hostname = getUrlHostname(url);
  const cause = getFetchCause(error);
  const code = typeof cause?.code === "string" ? cause.code : "";
  const causeMessage = typeof cause?.message === "string" ? cause.message : "";

  if (code === "ENOTFOUND") {
    return `DNS lookup failed for ${hostname}`;
  }

  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Connection to ${hostname} timed out`;
  }

  if (code === "ECONNREFUSED") {
    return `Connection refused by ${hostname}`;
  }

  if (code === "ECONNRESET") {
    return `Connection reset by ${hostname}`;
  }

  if (causeMessage && error.message === "fetch failed") {
    return causeMessage;
  }

  return error.message;
}

async function fetchText(url: string): Promise<FetchTextResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "AeroConciergeIngest/1.0",
        Accept:
          "text/html,application/xhtml+xml,text/plain,text/markdown,application/xml,text/xml,application/json,*/*"
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(url, error));
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type");

  if (
    contentType?.includes("application/pdf") ||
    contentType?.includes("application/octet-stream") ||
    contentType?.includes("application/vnd.openxmlformats-officedocument") ||
    contentType?.includes("application/msword")
  ) {
    return {
      text: "",
      contentType
    };
  }

  return {
    text: await response.text(),
    contentType
  };
}

function looksLikeSitemapUrl(url: string) {
  return /\.xml($|[?#])/i.test(url) || /sitemap/i.test(url);
}

function getSitemapFetchCandidates(sitemapUrl: string): string[] {
  const candidates = [sitemapUrl];

  try {
    const parsed = new URL(sitemapUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!/\.xml$/i.test(pathname) && /\/sitemap$/i.test(pathname)) {
      parsed.pathname = `${pathname}.xml`;
      candidates.push(parsed.toString());
    }
  } catch {
    // The URL schema validation happens before ingestion; keep the original error path if parsing fails here.
  }

  return uniqueByValue(candidates);
}

function decodeXmlEntities(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseSitemapXml(xml: string) {
  const $ = load(xml, { xmlMode: true });
  const pageUrls = $("url > loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean);
  const childSitemaps = $("sitemap > loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean);

  if (pageUrls.length > 0 || childSitemaps.length > 0) {
    const nestedSitemapUrls = pageUrls.filter((value) => looksLikeSitemapUrl(value));
    return {
      pageUrls: uniqueByValue(pageUrls.filter((value) => !looksLikeSitemapUrl(value))),
      childSitemaps: uniqueByValue([...childSitemaps, ...nestedSitemapUrls])
    };
  }

  const locs = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/gi))
    .map((match) => decodeXmlEntities((match[1] ?? "").trim()))
    .filter(Boolean);

  return {
    pageUrls: uniqueByValue(locs.filter((value) => !looksLikeSitemapUrl(value))),
    childSitemaps: uniqueByValue(locs.filter((value) => looksLikeSitemapUrl(value)))
  };
}

async function fetchSitemapUrls(
  sitemapUrl: string,
  maxUrls = 80,
  visited = new Set<string>()
): Promise<string[]> {
  if (visited.has(sitemapUrl) || maxUrls <= 0) {
    return [];
  }

  visited.add(sitemapUrl);

  let xml = "";
  let lastError: unknown = null;
  for (const candidate of getSitemapFetchCandidates(sitemapUrl)) {
    try {
      const fetched = await fetchText(candidate);
      xml = fetched.text;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!xml) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Failed to fetch sitemap"));
  }

  const parsed = parseSitemapXml(xml);
  const collected: string[] = [];

  for (const pageUrl of parsed.pageUrls) {
    if (collected.length >= maxUrls) {
      break;
    }
    collected.push(pageUrl);
  }

  for (const childSitemap of parsed.childSitemaps) {
    if (collected.length >= maxUrls) {
      break;
    }

    const remaining = maxUrls - collected.length;
    const nested = await fetchSitemapUrls(childSitemap, remaining, visited);
    for (const nestedUrl of nested) {
      if (collected.length >= maxUrls) {
        break;
      }
      collected.push(nestedUrl);
    }
  }

  return uniqueByValue(collected).slice(0, maxUrls);
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

function deriveUrlKeywords(url: string): string[] {
  try {
    return Array.from(
      new Set(
        new URL(url)
          .pathname
          .split(/[\/._-]+/)
          .map((part) => part.trim().toLowerCase())
          .filter((part) => part.length >= 4 && !["html", "xml", "pages", "posts", "index", "www"].includes(part))
      )
    );
  } catch {
    return [];
  }
}

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeJsStringLiteral(raw: string) {
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw;
  }
}

function isLikelyVisibleBundleText(input: string) {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length < 24 || text.length > 420) {
    return false;
  }

  const lower = text.toLowerCase();
  if (
    lower.includes("classname") ||
    lower.includes("children:") ||
    lower.includes("hover:") ||
    lower.includes("focus:") ||
    lower.includes("rounded-") ||
    lower.includes("shadow-") ||
    lower.includes("bg-") ||
    lower.includes("text-") ||
    lower.includes("border-") ||
    lower.includes("px-") ||
    lower.includes("py-") ||
    lower.includes("aria-")
  ) {
    return false;
  }

  if (/[{};]|&&|\|\|/.test(text)) {
    return false;
  }

  if (text.startsWith("http") || text.startsWith("/") || text.includes("function(") || text.includes("=>")) {
    return false;
  }

  const alphaSpaceChars = Array.from(text).filter((char) => /[A-Za-z\s]/.test(char)).length;
  if (alphaSpaceChars / text.length < 0.68) {
    return false;
  }

  return text.split(/\s+/).length >= 4;
}

function extractRouteComponentBlock(bundleText: string, pageUrl: string) {
  let pathname = "";

  try {
    pathname = new URL(pageUrl).pathname || "/";
  } catch {
    return "";
  }

  const routePattern = new RegExp(
    `path:\\s*"${escapeRegex(pathname)}"[^\\n]*?element:\\s*n\\.jsx\\(([A-Za-z_$][A-Za-z0-9_$]*)`,
    "m"
  );
  const routeMatch = routePattern.exec(bundleText);
  const componentName = routeMatch?.[1];
  if (!componentName) {
    return "";
  }

  const componentStartPattern = new RegExp(
    `(?:^|\\n)\\s*(?:const\\s+)?${escapeRegex(componentName)}\\s*=\\s*\\(\\)\\s*=>`,
    "m"
  );
  const componentStartMatch = componentStartPattern.exec(bundleText);
  if (!componentStartMatch) {
    return "";
  }

  const startIndex = componentStartMatch.index;
  const assignmentPattern = /\n\s*(?:const\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*=/g;
  assignmentPattern.lastIndex = startIndex + componentStartMatch[0].length;
  const nextAssignment = assignmentPattern.exec(bundleText);
  const endIndex = nextAssignment?.index ?? Math.min(bundleText.length, startIndex + 24000);

  return bundleText.slice(startIndex, endIndex);
}

function extractRelevantBundleText(bundleText: string, pageUrl: string, keywords: string[], maxChars = 2200) {
  if (keywords.length === 0) {
    return "";
  }

  const componentBlock = extractRouteComponentBlock(bundleText, pageUrl);
  const lines = (componentBlock || bundleText).split(/\r?\n/);
  const relevantIndexes = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const lower = (lines[index] ?? "").toLowerCase();
    if (!keywords.some((keyword) => lower.includes(keyword))) {
      continue;
    }

    for (let offset = -28; offset <= 28; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < lines.length) {
        relevantIndexes.add(nextIndex);
      }
    }
  }

  const relevantBlock = Array.from(relevantIndexes)
    .sort((a, b) => a - b)
    .map((index) => lines[index] ?? "")
    .join("\n");

  const candidates: string[] = [];
  const seen = new Set<string>();
  const pattern = /children:\s*"((?:[^"\\]|\\.){8,600})"/g;

  for (const match of relevantBlock.matchAll(pattern)) {
    const decoded = decodeJsStringLiteral(match[1] ?? "");
    const normalized = decoded.replace(/\s+/g, " ").trim();
    if (!isLikelyVisibleBundleText(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    candidates.push(normalized);
  }

  candidates.sort((left, right) => {
    const leftScore =
      keywords.reduce((score, keyword) => score + (left.toLowerCase().includes(keyword) ? 2 : 0), 0) +
      Math.min(left.length, 240) / 240;
    const rightScore =
      keywords.reduce((score, keyword) => score + (right.toLowerCase().includes(keyword) ? 2 : 0), 0) +
      Math.min(right.length, 240) / 240;
    return rightScore - leftScore;
  });

  let usedChars = 0;
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (usedChars + candidate.length > maxChars) {
      break;
    }
    selected.push(candidate);
    usedChars += candidate.length + 1;
  }

  return selected.join(" ");
}

async function extractSpaBundleText(pageUrl: string, html: string) {
  const keywords = deriveUrlKeywords(pageUrl);
  if (keywords.length === 0) {
    return "";
  }

  const $ = load(html);
  const origin = new URL(pageUrl).origin;
  const scriptUrls = uniqueByValue(
    $("script[src]")
      .map((_, element) => $(element).attr("src")?.trim() ?? "")
      .get()
      .filter(Boolean)
      .map((src) => {
        try {
          return new URL(src, pageUrl).toString();
        } catch {
          return "";
        }
      })
      .filter((src) => src.startsWith(origin) && /\.js($|[?#])/i.test(src))
  ).slice(0, 4);

  const fragments: string[] = [];
  for (const scriptUrl of scriptUrls) {
    try {
      const { text: bundleText } = await fetchText(scriptUrl);
      const extracted = extractRelevantBundleText(bundleText, pageUrl, keywords);
      if (extracted) {
        fragments.push(extracted);
      }
    } catch (error) {
      logError("platform_ingest_bundle_fetch_failed", {
        page_url: pageUrl,
        script_url: scriptUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return uniqueByValue(fragments).join(" ").trim();
}

async function parseWebDocument(url: string): Promise<ParsedDocumentContent> {
  const { text: rawText, contentType } = await fetchText(url);
  const normalizedContentType = contentType?.toLowerCase() ?? "";

  if (
    normalizedContentType.includes("application/pdf") ||
    normalizedContentType.includes("application/octet-stream") ||
    normalizedContentType.includes("application/vnd.openxmlformats-officedocument") ||
    normalizedContentType.includes("application/msword")
  ) {
    throw new Error(`Unsupported document type: ${contentType}`);
  }

  const defaultTitle = (() => {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(segments[segments.length - 1] || parsed.hostname || url);
    } catch {
      return url;
    }
  })();

  const isHtmlDocument =
    normalizedContentType.length === 0 ||
    normalizedContentType.includes("text/html") ||
    normalizedContentType.includes("application/xhtml");

  if (!isHtmlDocument) {
    const text = normalizeDocumentText(rawText);
    return {
      source_url: url,
      title: defaultTitle,
      text: normalizeDocumentText([defaultTitle, url, text].join(" "))
    };
  }

  const $ = load(rawText);

  const ldJsonStrings = parseLdJsonStrings($);
  $("script, style, noscript, iframe").remove();

  const title = $("title").first().text().trim() || defaultTitle;
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  const spaBundleText = bodyText.length < 160 ? await extractSpaBundleText(url, rawText) : "";

  const fullText = normalizeDocumentText([title, metaDescription, url, ...ldJsonStrings, bodyText, spaBundleText].join(" "));

  return {
    source_url: url,
    title,
    text: fullText
  };
}

function uniqueByValue(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function normalizeHost(value: string): string | null {
  try {
    return new URL(value).hostname.trim().toLowerCase();
  } catch {
    return null;
  }
}

function toResolvedSource(source: TenantSourceInput): ResolvedSource {
  return {
    ...source,
    source_host:
      source.source_type === "url" || source.source_type === "sitemap"
        ? normalizeHost(source.source_value)
        : null
  };
}

async function resolveSourcesToDocs(
  sources: TenantSourceInput[],
  maxSitemapUrls: number
): Promise<{ docs: ParsedDoc[]; errors: string[] }> {
  const docs: ParsedDoc[] = [];
  const errors: string[] = [];

  const resolvedSources = sources.map(toResolvedSource);
  const rawTextSources = resolvedSources.filter(
    (source) => source.source_type === "faq" || source.source_type === "doc_text"
  );

  for (const source of rawTextSources) {
    const text = normalizeDocumentText(source.source_value);
    if (!text) {
      continue;
    }

    docs.push({
      source_url: null,
      title: source.source_type === "faq" ? "FAQ Import" : "Document Import",
      text,
      source
    });
  }

  const urlSourceMap = new Map<string, ResolvedSource>();
  const seenSitemaps = new Set<string>();

  for (const source of resolvedSources) {
    if (source.source_type === "url") {
      const key = source.source_value.trim();
      if (!key) {
        continue;
      }

      if (looksLikeSitemapUrl(key)) {
        if (seenSitemaps.has(key)) {
          continue;
        }
        seenSitemaps.add(key);

        try {
          const sitemapUrls = await fetchSitemapUrls(key, maxSitemapUrls);
          for (const pageUrl of sitemapUrls) {
            const pageKey = pageUrl.trim();
            if (pageKey && !urlSourceMap.has(pageKey)) {
              urlSourceMap.set(pageKey, source);
            }
          }
        } catch (error) {
          errors.push(`Sitemap failed (${key}): ${error instanceof Error ? error.message : String(error)}`);
          logError("platform_ingest_sitemap_failed", {
            sitemap: key,
            source_id: source.source_id ?? null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        continue;
      }

      if (!urlSourceMap.has(key)) {
        urlSourceMap.set(key, source);
      }
      continue;
    }

    if (source.source_type === "sitemap") {
      const sitemap = source.source_value.trim();
      if (!sitemap || seenSitemaps.has(sitemap)) {
        continue;
      }
      seenSitemaps.add(sitemap);

      try {
        const sitemapUrls = await fetchSitemapUrls(sitemap, maxSitemapUrls);
        for (const pageUrl of sitemapUrls) {
          const key = pageUrl.trim();
          if (key && !urlSourceMap.has(key)) {
            urlSourceMap.set(key, source);
          }
        }
      } catch (error) {
        errors.push(`Sitemap failed (${sitemap}): ${error instanceof Error ? error.message : String(error)}`);
        logError("platform_ingest_sitemap_failed", {
          sitemap,
          source_id: source.source_id ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const parsedDocs = await mapWithConcurrency(
    Array.from(urlSourceMap.entries()),
    DOCUMENT_FETCH_CONCURRENCY,
    async ([url, source]) => {
    try {
      const doc = await parseWebDocument(url);
      if (doc.text.length < 60) {
        return null;
      }

      return {
        ...doc,
        source
      };
    } catch (error) {
      errors.push(
        `URL failed (${url}): ${error instanceof Error ? error.message : String(error)}`
      );
      logError("platform_ingest_url_failed", {
        url,
        source_id: source.source_id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
    }
  );

  for (const doc of parsedDocs) {
    if (doc) {
      docs.push(doc);
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
  let fetchedDocs = 0;
  const chunkJobs: ChunkJob[] = [];
  let leakedKeyDetected = false;

  for (const doc of docs) {
    const chunks = chunkText(doc.text);
    if (chunks.length === 0) {
      continue;
    }

    fetchedDocs += 1;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (chunkJobs.length >= maxChunks) {
        break;
      }

      const chunkTextValue = chunks[chunkIndex] ?? "";
      const signature = chunkTextValue.toLowerCase().replace(/\s+/g, " ").trim();
      if (!signature || seenChunks.has(signature)) {
        continue;
      }

      seenChunks.add(signature);
      chunkJobs.push({
        doc,
        chunk_index: chunkIndex,
        chunk_text: chunkTextValue
      });
    }

    if (chunkJobs.length >= maxChunks) {
      break;
    }
  }

  const chunkResults = await mapWithConcurrency(chunkJobs, CHUNK_INGEST_CONCURRENCY, async (job) => {
    if (leakedKeyDetected) {
      return false;
    }

    try {
      const embedding = await embedDocumentText(job.chunk_text);
      const sourceHost = job.doc.source_url
        ? normalizeHost(job.doc.source_url)
        : job.doc.source.source_host;
      const { error } = await supabaseAdmin.from("knowledge_chunks").insert({
        tenant_id: input.tenant_id,
        source_url: job.doc.source_url,
        title: job.doc.title,
        chunk_text: job.chunk_text,
        embedding,
        metadata: {
          chunk_index: job.chunk_index,
          source_id: job.doc.source.source_id ?? null,
          source_type: job.doc.source.source_type,
          source_value: job.doc.source.source_value,
          source_host: sourceHost,
          source_title: job.doc.title,
          ingested_at: new Date().toISOString()
        }
      });

      if (error) {
        errors.push(`Chunk insert failed (${job.doc.title}): ${error.message}`);
        return false;
      }

      return true;
    } catch (error) {
      if (isLeakedEmbeddingKeyError(error)) {
        leakedKeyDetected = true;
        errors.push(
          "Embedding provider rejected GEMINI_API_KEY because it is flagged as leaked. Rotate the key, update backend environment variables, restart the backend, and rerun ingestion."
        );
        return false;
      }
      errors.push(`Embedding failed (${job.doc.title}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });

  const insertedChunks = chunkResults.filter(Boolean).length;

  const result: IngestTenantResult = {
    tenant_id: input.tenant_id,
    inserted_chunks: insertedChunks,
    fetched_documents: fetchedDocs,
    skipped_documents: Math.max(0, docs.length - fetchedDocs),
    errors: uniqueByValue(errors)
  };

  logInfo("platform_ingest_completed", result);
  return result;
}
