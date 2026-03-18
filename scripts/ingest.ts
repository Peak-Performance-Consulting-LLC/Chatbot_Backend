import { loadLocalEnv } from "./envLoader";
import type { TenantSourceInput } from "@/rag/ingest";

type CliArgs = {
  tenant_id?: string;
  urls?: string;
  sitemap?: string;
  faq_text?: string;
  replace?: string;
  max_sitemap_urls?: string;
  max_chunks?: string;
};

function parseArgs(argv: string[]): CliArgs {
  return argv.reduce<CliArgs>((acc, arg) => {
    if (!arg.startsWith("--")) {
      return acc;
    }

    const [rawKey, ...rawValue] = arg.slice(2).split("=");
    acc[rawKey as keyof CliArgs] = rawValue.join("=") || "true";
    return acc;
  }, {});
}

function buildSources(args: CliArgs): TenantSourceInput[] {
  const sources: TenantSourceInput[] = [];

  if (args.urls) {
    for (const item of args.urls.split(",").map((url) => url.trim()).filter(Boolean)) {
      sources.push({
        source_type: "url",
        source_value: item
      });
    }
  }

  if (args.sitemap) {
    sources.push({
      source_type: "sitemap",
      source_value: args.sitemap.trim()
    });
  }

  if (args.faq_text?.trim()) {
    sources.push({
      source_type: "faq",
      source_value: args.faq_text.trim()
    });
  }

  return sources;
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const { ingestKnowledgeForTenant } = await import("@/rag/ingest");

  if (!args.tenant_id?.trim()) {
    throw new Error("Missing --tenant_id=...");
  }

  const sources = buildSources(args);
  if (sources.length === 0) {
    throw new Error("Provide --urls=... or --sitemap=... or --faq_text=...");
  }

  const result = await ingestKnowledgeForTenant({
    tenant_id: args.tenant_id.trim(),
    sources,
    replace: args.replace === "true",
    max_sitemap_urls: args.max_sitemap_urls ? Number(args.max_sitemap_urls) : undefined,
    max_chunks: args.max_chunks ? Number(args.max_chunks) : undefined
  });

  console.log(
    `Done. Inserted ${result.inserted_chunks} chunks from ${result.fetched_documents} documents for tenant '${result.tenant_id}'.`
  );

  if (result.errors.length > 0) {
    console.log("Warnings:");
    for (const item of result.errors.slice(0, 20)) {
      console.log(`- ${item}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
