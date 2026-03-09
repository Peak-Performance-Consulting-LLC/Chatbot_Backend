import fs from "fs";
import path from "path";
import { ingestKnowledgeForTenant, type TenantSourceInput } from "@/rag/ingest";

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

function loadEnvFromLocalFile() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = line.slice(index + 1).trim();
    const value =
      (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;

    process.env[key] = value;
  }
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
  loadEnvFromLocalFile();
  const args = parseArgs(process.argv.slice(2));

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

