import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

type Status = "ok" | "warn" | "fail";

type CheckResult = {
  name: string;
  status: Status;
  detail: string;
};

function parseArgs(argv: string[]): Record<string, string> {
  return argv.reduce<Record<string, string>>((acc, arg) => {
    if (!arg.startsWith("--")) {
      return acc;
    }

    const [rawKey, ...rest] = arg.slice(2).split("=");
    const value = rest.join("=");
    if (rawKey) {
      acc[rawKey] = value || "true";
    }
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

async function checkEnvKeys(): Promise<CheckResult[]> {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GEMINI_API_KEY",
    "GEMINI_CHAT_MODEL",
    "GEMINI_EMBEDDING_MODEL",
    "FLIGHT_SEARCH_URL",
    "CALL_CTA_NUMBER"
  ];

  const missing = required.filter((key) => !process.env[key] || !process.env[key]?.trim());
  if (missing.length > 0) {
    return [
      {
        name: "Environment variables",
        status: "fail",
        detail: `Missing: ${missing.join(", ")}`
      }
    ];
  }

  return [
    {
      name: "Environment variables",
      status: "ok",
      detail: "Required variables are present."
    }
  ];
}

async function checkSupabaseSchema(args: Record<string, string>): Promise<CheckResult[]> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const tenantId = args.tenant_id || process.env.DOCTOR_TENANT_ID || process.env.VITE_TENANT_ID || "";

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const results: CheckResult[] = [];
  const requiredTables = [
    "tenants",
    "chats",
    "messages",
    "flight_search_states",
    "service_request_states",
    "knowledge_chunks",
    "platform_users",
    "platform_sessions",
    "platform_user_tenants",
    "tenant_domain_verifications",
    "tenant_sources",
    "platform_password_resets"
  ];

  for (const table of requiredTables) {
    const { error } = await supabase.from(table).select("*").limit(1);
    if (error) {
      results.push({
        name: `Table: ${table}`,
        status: "fail",
        detail: error.message
      });
      continue;
    }

    results.push({
      name: `Table: ${table}`,
      status: "ok",
      detail: "Accessible"
    });
  }

  const tenantProfileColumns = [
    "business_type",
    "supported_services",
    "support_phone",
    "support_email",
    "support_cta_label",
    "business_description"
  ].join(", ");
  const { error: tenantColumnsError } = await supabase
    .from("tenants")
    .select(tenantProfileColumns)
    .limit(1);

  if (tenantColumnsError) {
    results.push({
      name: "Table: tenants profile columns",
      status: "fail",
      detail: tenantColumnsError.message
    });
  } else {
    results.push({
      name: "Table: tenants profile columns",
      status: "ok",
      detail: "Accessible"
    });
  }

  const { error: rpcError } = await supabase.rpc("match_knowledge_chunks", {
    query_embedding: Array(768).fill(0),
    match_count: 1,
    tenant: tenantId || "doctor"
  });

  if (rpcError) {
    results.push({
      name: "RPC: match_knowledge_chunks",
      status: "fail",
      detail: rpcError.message
    });
  } else {
    results.push({
      name: "RPC: match_knowledge_chunks",
      status: "ok",
      detail: "Accessible"
    });
  }

  if (tenantId) {
    const { data, error } = await supabase
      .from("tenants")
      .select("tenant_id, allowed_domains")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (error) {
      results.push({
        name: `Tenant: ${tenantId}`,
        status: "fail",
        detail: error.message
      });
    } else if (!data) {
      results.push({
        name: `Tenant: ${tenantId}`,
        status: "fail",
        detail: "Tenant record not found."
      });
    } else {
      const domains = Array.isArray(data.allowed_domains) ? data.allowed_domains.join(", ") : "none";
      results.push({
        name: `Tenant: ${tenantId}`,
        status: "ok",
        detail: `Allowed domains: ${domains}`
      });
    }
  } else {
    results.push({
      name: "Tenant check",
      status: "warn",
      detail: "No tenant_id provided. Use --tenant_id=your-tenant for tenant diagnostics."
    });
  }

  return results;
}

async function checkGemini(): Promise<CheckResult> {
  try {
    const genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY ?? ""
    });
    const chatModelName = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
    const embeddingModelName = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

    const chatResp = await genAI.models.generateContent({
      model: chatModelName,
      contents: [{ role: "user", parts: [{ text: "Reply only with: OK" }] }]
    });
    const chatText = (chatResp.text ?? "").trim();
    if (!chatText) {
      throw new Error(`Chat model '${chatModelName}' returned an empty response`);
    }

    const embedResp = await genAI.models.embedContent({
      model: embeddingModelName,
      contents: [{ role: "user", parts: [{ text: "doctor check" }] }],
      config: {
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 768
      }
    });
    const firstEmbedding = embedResp.embeddings?.[0]?.values;
    if (!Array.isArray(firstEmbedding) || firstEmbedding.length !== 768) {
      throw new Error(`Embedding model '${embeddingModelName}' did not return 768 dimensions`);
    }

    return {
      name: "Gemini API key",
      status: "ok",
      detail: `Chat (${chatModelName}) + embedding (${embeddingModelName}) calls succeeded.`
    };
  } catch (error) {
    return {
      name: "Gemini API key",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkFlightApi(): Promise<CheckResult> {
  const url = process.env.FLIGHT_SEARCH_URL ?? "https://serp-api-olive.vercel.app/api/flights/search";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: "JFK",
        destination: "LAX",
        departure_date: "2026-03-15",
        passengers: [{ type: "adult" }],
        cabin_class: "economy"
      })
    });

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      return {
        name: "Flight API",
        status: "fail",
        detail: `HTTP ${response.status}: ${typeof json.error === "string" ? json.error : "Request failed"}`
      };
    }

    const count = Array.isArray(json.flights)
      ? json.flights.length
      : Array.isArray((json.data as Record<string, unknown> | undefined)?.flights)
        ? (((json.data as Record<string, unknown>).flights as unknown[]) ?? []).length
        : 0;

    return {
      name: "Flight API",
      status: "ok",
      detail: `Request succeeded. Returned ${count} flights in sample test.`
    };
  } catch (error) {
    return {
      name: "Flight API",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function printResults(results: CheckResult[]) {
  let failures = 0;

  for (const result of results) {
    const badge = result.status === "ok" ? "OK   " : result.status === "warn" ? "WARN " : "FAIL ";
    if (result.status === "fail") {
      failures += 1;
    }
    console.log(`${badge} ${result.name}: ${result.detail}`);
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }

  console.log("All critical checks passed.");
}

async function main() {
  loadEnvFromLocalFile();
  const args = parseArgs(process.argv.slice(2));

  const envResults = await checkEnvKeys();
  const envFailed = envResults.some((item) => item.status === "fail");
  if (envFailed) {
    printResults(envResults);
    return;
  }

  const schemaResults = await checkSupabaseSchema(args);
  const geminiResult = await checkGemini();
  const flightResult = await checkFlightApi();

  printResults([...envResults, ...schemaResults, geminiResult, flightResult]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
