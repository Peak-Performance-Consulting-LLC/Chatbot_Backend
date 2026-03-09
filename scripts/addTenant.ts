import { createClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "./envLoader";

type CliArgs = {
  tenant_id?: string;
  name?: string;
  domains?: string;
};

function parseArgs(argv: string[]): CliArgs {
  return argv.reduce<CliArgs>((acc, arg) => {
    if (!arg.startsWith("--")) {
      return acc;
    }

    const [rawKey, ...rawValue] = arg.slice(2).split("=");
    acc[rawKey as keyof CliArgs] = rawValue.join("=") || "";
    return acc;
  }, {});
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .split("/")[0] || domain.trim().toLowerCase();
}

async function main() {
  loadLocalEnv();

  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant_id) {
    throw new Error("Missing --tenant_id=...");
  }

  const domains = (args.domains || "")
    .split(",")
    .map((d) => normalizeDomain(d))
    .filter(Boolean);

  if (domains.length === 0) {
    throw new Error("Missing --domains=domain1.com,www.domain1.com,localhost");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRole) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const payload = {
    tenant_id: args.tenant_id,
    name: args.name || args.tenant_id,
    allowed_domains: domains
  };

  const { data, error } = await supabase
    .from("tenants")
    .upsert(payload, { onConflict: "tenant_id" })
    .select("tenant_id,name,allowed_domains")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to upsert tenant");
  }

  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
