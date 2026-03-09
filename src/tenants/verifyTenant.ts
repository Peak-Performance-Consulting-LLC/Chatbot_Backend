import { HttpError } from "@/lib/httpError";
import { getRequestHost } from "@/lib/request";
import { supabaseAdmin } from "@/lib/supabase";

type TenantRow = {
  tenant_id: string;
  name: string | null;
  allowed_domains: string[];
  business_type: string;
  supported_services: Array<"flights" | "hotels" | "cars" | "cruises">;
  support_phone: string | null;
  support_email: string | null;
  support_cta_label: string;
  business_description: string | null;
};

const defaultServices = ["flights"] as const;

function normalizeSupportedServices(input: unknown): Array<"flights" | "hotels" | "cars" | "cruises"> {
  if (!Array.isArray(input)) {
    return [...defaultServices];
  }

  const values = new Set<"flights" | "hotels" | "cars" | "cruises">();
  for (const item of input) {
    const value = String(item).trim().toLowerCase();
    if (value === "flights" || value === "hotels" || value === "cars" || value === "cruises") {
      values.add(value);
    }
  }

  if (values.size === 0) {
    values.add("flights");
  }

  return Array.from(values);
}

function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  return withoutProtocol.replace(/\/$/, "").split("/")[0] ?? withoutProtocol;
}

function matchesDomain(host: string, rule: string): boolean {
  const normalizedHost = normalizeDomain(host).split(":")[0];
  const normalizedRule = normalizeDomain(rule).split(":")[0];

  if (normalizedRule === normalizedHost) {
    return true;
  }

  if (normalizedRule.startsWith("*.")) {
    const bare = normalizedRule.slice(2);
    return normalizedHost === bare || normalizedHost.endsWith(`.${bare}`);
  }

  return false;
}

export async function getTenantById(tenantId: string): Promise<TenantRow> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, business_description"
    )
    .eq("tenant_id", tenantId)
    .single();

  if (error) {
    const missingColumns =
      error.message.includes("column tenants.business_type does not exist") ||
      error.message.includes("column tenants.supported_services does not exist");

    if (missingColumns) {
      throw new HttpError(
        500,
        "Tenant business profile columns are missing. Run backend/supabase/schema.sql and reload schema cache."
      );
    }

    throw new HttpError(404, `Tenant '${tenantId}' not found`);
  }

  if (!data) {
    throw new HttpError(404, `Tenant '${tenantId}' not found`);
  }

  const row = data as {
    tenant_id: string;
    name: string | null;
    allowed_domains: string[];
    business_type?: string | null;
    supported_services?: string[] | null;
    support_phone?: string | null;
    support_email?: string | null;
    support_cta_label?: string | null;
    business_description?: string | null;
  };

  return {
    tenant_id: row.tenant_id,
    name: row.name,
    allowed_domains: row.allowed_domains,
    business_type: row.business_type?.trim() || "general_travel",
    supported_services: normalizeSupportedServices(row.supported_services),
    support_phone: row.support_phone?.trim() || null,
    support_email: row.support_email?.trim() || null,
    support_cta_label: row.support_cta_label?.trim() || "Connect with a specialist",
    business_description: row.business_description?.trim() || null
  };
}

async function isTenantDomainVerified(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("status")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    const missingTable =
      error.message.includes("Could not find the table 'public.tenant_domain_verifications'") ||
      error.message.includes("relation \"public.tenant_domain_verifications\" does not exist");

    if (missingTable) {
      if (process.env.NODE_ENV !== "production") {
        return true;
      }

      throw new HttpError(500, "Domain verification table is missing. Run the latest Supabase schema migration.");
    }

    throw new HttpError(500, `Tenant verification lookup failed: ${error.message}`);
  }

  if (!data) {
    return false;
  }

  return (data as { status?: string }).status === "verified";
}

export async function assertTenantDomainAccess(request: Request, tenantId: string): Promise<TenantRow> {
  const tenant = await getTenantById(tenantId);
  const requestHost = getRequestHost(request);

  if (!requestHost) {
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(403, "Origin host is required for tenant validation");
    }

    return tenant;
  }

  const normalizedHost = normalizeDomain(requestHost).split(":")[0];
  const isDevHost = normalizedHost === "localhost" || normalizedHost === "127.0.0.1";
  if (process.env.NODE_ENV !== "production" && isDevHost) {
    return tenant;
  }

  const isAllowed = tenant.allowed_domains.some((domain) => matchesDomain(requestHost, domain));

  if (!isAllowed) {
    throw new HttpError(403, `Domain '${requestHost}' is not allowed for tenant '${tenantId}'`);
  }

  if (process.env.NODE_ENV === "production") {
    const verified = await isTenantDomainVerified(tenantId);
    if (!verified) {
      throw new HttpError(403, `Domain for tenant '${tenantId}' is not DNS verified yet`);
    }
  }

  return tenant;
}
