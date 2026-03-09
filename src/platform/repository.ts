import { getEnv } from "@/config/env";
import { createSessionToken, hashSessionToken, hashPassword, verifyPassword } from "@/platform/auth";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";

function isMissingTableErrorMessage(message: string): boolean {
  return (
    message.includes("Could not find the table 'public.platform_users'") ||
    message.includes("Could not find the table 'public.platform_sessions'") ||
    message.includes("Could not find the table 'public.platform_user_tenants'") ||
    message.includes("Could not find the table 'public.tenant_domain_verifications'") ||
    message.includes("Could not find the table 'public.tenant_sources'") ||
    message.includes('relation "public.platform_users" does not exist') ||
    message.includes('relation "public.platform_sessions" does not exist') ||
    message.includes('relation "public.platform_user_tenants" does not exist') ||
    message.includes('relation "public.tenant_domain_verifications" does not exist') ||
    message.includes('relation "public.tenant_sources" does not exist') ||
    message.includes("column tenants.business_type does not exist") ||
    message.includes("column tenants.supported_services does not exist") ||
    message.includes("column tenants.support_phone does not exist") ||
    message.includes("column tenants.support_email does not exist") ||
    message.includes("column tenants.support_cta_label does not exist") ||
    message.includes("column tenants.business_description does not exist")
  );
}

function throwPlatformSchemaMissingError(message: string): never {
  if (isMissingTableErrorMessage(message)) {
    throw new HttpError(
      500,
      `Platform schema is missing or outdated in Supabase. Run backend/supabase/schema.sql and reload schema cache. Root cause: ${message}`
    );
  }

  throw new HttpError(500, message);
}

type PlatformUserRow = {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  created_at: string;
};

type PlatformSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
};

type DomainVerificationRow = {
  tenant_id: string;
  domain: string;
  txt_name: string;
  txt_value: string;
  status: "pending" | "verified";
  verified_at: string | null;
  created_at: string;
};

type TenantSourceRow = {
  id: string;
  tenant_id: string;
  source_type: "sitemap" | "url" | "faq" | "doc_text";
  source_value: string;
  created_at: string;
};

type TenantSummary = {
  tenant_id: string;
  name: string | null;
  allowed_domains: string[];
  business_profile: TenantBusinessProfile;
  domain_verification: {
    status: "pending" | "verified";
    txt_name: string;
    txt_value: string;
    verified_at: string | null;
  } | null;
};

const supportedServices = ["flights", "hotels", "cars", "cruises"] as const;
export type SupportedService = (typeof supportedServices)[number];

export type TenantBusinessProfile = {
  business_type: string;
  supported_services: SupportedService[];
  support_phone: string | null;
  support_email: string | null;
  support_cta_label: string;
  business_description: string | null;
};

function normalizeSupportedServices(input?: string[] | null): SupportedService[] {
  if (!Array.isArray(input) || input.length === 0) {
    return ["flights"];
  }

  const values = new Set<SupportedService>();
  for (const service of input) {
    const normalized = String(service).trim().toLowerCase();
    if (supportedServices.includes(normalized as SupportedService)) {
      values.add(normalized as SupportedService);
    }
  }

  if (values.size === 0) {
    values.add("flights");
  }

  return Array.from(values);
}

function normalizeBusinessProfile(input?: Partial<TenantBusinessProfile>): TenantBusinessProfile {
  const supportPhone = input?.support_phone?.trim();
  const supportEmail = input?.support_email?.trim();
  const supportCtaLabel = input?.support_cta_label?.trim();
  const businessDescription = input?.business_description?.trim();

  return {
    business_type: input?.business_type?.trim() || "general_travel",
    supported_services: normalizeSupportedServices(input?.supported_services as string[] | undefined),
    support_phone: supportPhone || null,
    support_email: supportEmail || null,
    support_cta_label: supportCtaLabel || "Connect with a specialist",
    business_description: businessDescription || null
  };
}

export type PlatformSession = {
  token: string;
  expires_at: string;
};

export function normalizeDomain(input: string): string {
  const normalized = input.trim().toLowerCase();

  try {
    const url = normalized.startsWith("http://") || normalized.startsWith("https://")
      ? new URL(normalized)
      : new URL(`https://${normalized}`);
    return url.hostname.toLowerCase();
  } catch {
    throw new HttpError(400, "Invalid website URL or domain");
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function tenantExists(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Tenant lookup failed: ${error.message}`);
  }

  return Boolean(data?.tenant_id);
}

async function generateTenantId(companyName: string, domain: string): Promise<string> {
  const seed = slugify(companyName) || slugify(domain.split(".")[0] ?? "") || "tenant";
  let candidate = seed;
  let counter = 1;

  while (await tenantExists(candidate)) {
    counter += 1;
    candidate = `${seed}-${counter}`;
  }

  return candidate;
}

export async function getPlatformUserByEmail(email: string): Promise<PlatformUserRow | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .select("*")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load platform user: ${error.message}`);
  }

  return (data as PlatformUserRow | null) ?? null;
}

export async function deletePlatformUserById(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("platform_users")
    .delete()
    .eq("id", userId);

  if (error) {
    throw new HttpError(500, `Failed to delete platform user: ${error.message}`);
  }
}

export async function findTenantIdByDomain(domainInput: string): Promise<string | null> {
  const domain = normalizeDomain(domainInput);
  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("tenant_id")
    .eq("domain", domain)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Domain lookup failed: ${error.message}`);
  }

  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

export async function getPlatformUserById(userId: string): Promise<PlatformUserRow | null> {
  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load platform user: ${error.message}`);
  }

  return (data as PlatformUserRow | null) ?? null;
}

export async function createPlatformUser(input: {
  fullName: string;
  email: string;
  password: string;
}): Promise<Pick<PlatformUserRow, "id" | "email" | "full_name" | "created_at">> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const existing = await getPlatformUserByEmail(normalizedEmail);
  if (existing) {
    throw new HttpError(409, "Email is already registered");
  }

  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .insert({
      full_name: input.fullName.trim(),
      email: normalizedEmail,
      password_hash: hashPassword(input.password)
    })
    .select("id, email, full_name, created_at")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to create platform user: ${error?.message ?? "Unknown error"}`);
  }

  return data as Pick<PlatformUserRow, "id" | "email" | "full_name" | "created_at">;
}

export async function validatePlatformCredentials(input: {
  email: string;
  password: string;
}): Promise<Pick<PlatformUserRow, "id" | "email" | "full_name" | "created_at">> {
  const user = await getPlatformUserByEmail(input.email);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw new HttpError(401, "Invalid email or password");
  }

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    created_at: user.created_at
  };
}

export async function createPlatformSession(userId: string): Promise<PlatformSession> {
  const env = getEnv();
  const ttlDays = Number(env.PLATFORM_SESSION_TTL_DAYS || 30);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const { token, tokenHash } = createSessionToken();

  const { error } = await supabaseAdmin
    .from("platform_sessions")
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt
    });

  if (error) {
    throw new HttpError(500, `Failed to create session: ${error.message}`);
  }

  return {
    token,
    expires_at: expiresAt
  };
}

export async function resolvePlatformSession(token: string): Promise<Pick<PlatformUserRow, "id" | "email" | "full_name" | "created_at">> {
  const { data, error } = await supabaseAdmin
    .from("platform_sessions")
    .select("*")
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load session: ${error.message}`);
  }

  const session = (data as PlatformSessionRow | null) ?? null;
  if (!session) {
    throw new HttpError(401, "Invalid session token");
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, "Session has expired");
  }

  const user = await getPlatformUserById(session.user_id);
  if (!user) {
    throw new HttpError(401, "Session user not found");
  }

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    created_at: user.created_at
  };
}

export async function createTenantForUser(input: {
  userId: string;
  companyName: string;
  domain: string;
  businessProfile?: Partial<TenantBusinessProfile>;
}): Promise<{ tenant_id: string; name: string; allowed_domains: string[]; business_profile: TenantBusinessProfile }> {
  const domain = normalizeDomain(input.domain);
  const businessProfile = normalizeBusinessProfile(input.businessProfile);

  const { data: existingDomain, error: domainError } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("tenant_id")
    .eq("domain", domain)
    .maybeSingle();

  if (domainError) {
    throw new HttpError(500, `Domain lookup failed: ${domainError.message}`);
  }

  if (existingDomain?.tenant_id) {
    throw new HttpError(409, "This domain is already connected to another tenant");
  }

  const tenantId = await generateTenantId(input.companyName, domain);
  const tenantPayload = {
    tenant_id: tenantId,
    name: input.companyName.trim(),
    allowed_domains: [domain],
    business_type: businessProfile.business_type,
    supported_services: businessProfile.supported_services,
    support_phone: businessProfile.support_phone,
    support_email: businessProfile.support_email,
    support_cta_label: businessProfile.support_cta_label,
    business_description: businessProfile.business_description
  };

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert(tenantPayload)
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, business_description"
    )
    .single();

  if (tenantError || !tenant) {
    throw new HttpError(500, `Failed to create tenant: ${tenantError?.message ?? "Unknown error"}`);
  }

  const { error: linkError } = await supabaseAdmin
    .from("platform_user_tenants")
    .insert({
      user_id: input.userId,
      tenant_id: tenantId
    });

  if (linkError) {
    throw new HttpError(500, `Failed to link tenant ownership: ${linkError.message}`);
  }

  const tenantRow = tenant as {
    tenant_id: string;
    name: string;
    allowed_domains: string[];
    business_type: string;
    supported_services: string[];
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    business_description: string | null;
  };

  return {
    tenant_id: tenantRow.tenant_id,
    name: tenantRow.name,
    allowed_domains: tenantRow.allowed_domains,
    business_profile: normalizeBusinessProfile({
      business_type: tenantRow.business_type,
      supported_services: tenantRow.supported_services as SupportedService[],
      support_phone: tenantRow.support_phone,
      support_email: tenantRow.support_email,
      support_cta_label: tenantRow.support_cta_label ?? undefined,
      business_description: tenantRow.business_description
    })
  };
}

export async function assertTenantOwnership(userId: string, tenantId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("platform_user_tenants")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to check tenant ownership: ${error.message}`);
  }

  if (!data?.tenant_id) {
    throw new HttpError(403, "Tenant access denied");
  }
}

export async function upsertDomainVerification(input: {
  tenantId: string;
  domain: string;
  txtName: string;
  txtValue: string;
}): Promise<DomainVerificationRow> {
  const payload = {
    tenant_id: input.tenantId,
    domain: normalizeDomain(input.domain),
    txt_name: input.txtName.trim().toLowerCase(),
    txt_value: input.txtValue.trim(),
    status: "pending" as const,
    verified_at: null
  };

  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .upsert(payload, { onConflict: "tenant_id" })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to save domain verification details: ${error?.message ?? "Unknown error"}`);
  }

  return data as DomainVerificationRow;
}

export async function updateTenantAllowedDomain(input: {
  tenantId: string;
  domain: string;
}): Promise<{ tenant_id: string; domain: string; allowed_domains: string[] }> {
  const domain = normalizeDomain(input.domain);

  const { data: existingDomain, error: domainError } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("tenant_id")
    .eq("domain", domain)
    .maybeSingle();

  if (domainError) {
    throw new HttpError(500, `Domain lookup failed: ${domainError.message}`);
  }

  if (existingDomain?.tenant_id && existingDomain.tenant_id !== input.tenantId) {
    throw new HttpError(409, "This domain is already connected to another tenant");
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .update({
      allowed_domains: [domain]
    })
    .eq("tenant_id", input.tenantId)
    .select("tenant_id, allowed_domains")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to update tenant domain: ${error?.message ?? "Unknown error"}`);
  }

  return {
    tenant_id: (data as { tenant_id: string }).tenant_id,
    domain,
    allowed_domains: (data as { allowed_domains: string[] }).allowed_domains
  };
}

export async function getDomainVerification(tenantId: string): Promise<DomainVerificationRow | null> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to load domain verification: ${error.message}`);
  }

  return (data as DomainVerificationRow | null) ?? null;
}

export async function markDomainVerified(tenantId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .update({
      status: "verified",
      verified_at: new Date().toISOString()
    })
    .eq("tenant_id", tenantId);

  if (error) {
    throw new HttpError(500, `Failed to mark domain as verified: ${error.message}`);
  }
}

export async function replaceTenantSources(
  tenantId: string,
  sources: Array<{ source_type: "sitemap" | "url" | "faq" | "doc_text"; source_value: string }>
): Promise<void> {
  const { error: deleteError } = await supabaseAdmin
    .from("tenant_sources")
    .delete()
    .eq("tenant_id", tenantId);

  if (deleteError) {
    throw new HttpError(500, `Failed to reset tenant sources: ${deleteError.message}`);
  }

  if (sources.length === 0) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("tenant_sources")
    .insert(
      sources.map((source) => ({
        tenant_id: tenantId,
        source_type: source.source_type,
        source_value: source.source_value
      }))
    );

  if (error) {
    throw new HttpError(500, `Failed to store tenant sources: ${error.message}`);
  }
}

export async function listTenantSources(tenantId: string): Promise<TenantSourceRow[]> {
  const { data, error } = await supabaseAdmin
    .from("tenant_sources")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new HttpError(500, `Failed to load tenant sources: ${error.message}`);
  }

  return (data ?? []) as TenantSourceRow[];
}

export async function updateTenantBusinessProfile(
  tenantId: string,
  patch: Partial<TenantBusinessProfile>
): Promise<TenantBusinessProfile> {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("tenants")
    .select(
      "tenant_id, business_type, supported_services, support_phone, support_email, support_cta_label, business_description"
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (existingError) {
    throwPlatformSchemaMissingError(`Failed to load tenant business profile: ${existingError.message}`);
  }

  if (!existing) {
    throw new HttpError(404, "Tenant not found");
  }

  const current = existing as {
    business_type: string | null;
    supported_services: string[] | null;
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    business_description: string | null;
  };

  const next = normalizeBusinessProfile({
    business_type: patch.business_type ?? current.business_type ?? undefined,
    supported_services:
      (patch.supported_services as SupportedService[] | undefined) ??
      (current.supported_services as SupportedService[] | null) ??
      undefined,
    support_phone: patch.support_phone ?? current.support_phone,
    support_email: patch.support_email ?? current.support_email,
    support_cta_label: patch.support_cta_label ?? current.support_cta_label ?? undefined,
    business_description: patch.business_description ?? current.business_description
  });

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({
      business_type: next.business_type,
      supported_services: next.supported_services,
      support_phone: next.support_phone,
      support_email: next.support_email,
      support_cta_label: next.support_cta_label,
      business_description: next.business_description
    })
    .eq("tenant_id", tenantId);

  if (error) {
    throwPlatformSchemaMissingError(`Failed to update tenant business profile: ${error.message}`);
  }

  return next;
}

export async function listUserTenants(userId: string): Promise<TenantSummary[]> {
  const { data: links, error: linksError } = await supabaseAdmin
    .from("platform_user_tenants")
    .select("tenant_id")
    .eq("user_id", userId);

  if (linksError) {
    throw new HttpError(500, `Failed to load user tenants: ${linksError.message}`);
  }

  const tenantIds = (links ?? []).map((item) => (item as { tenant_id: string }).tenant_id);
  if (tenantIds.length === 0) {
    return [];
  }

  const { data: tenants, error: tenantsError } = await supabaseAdmin
    .from("tenants")
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, business_description"
    )
    .in("tenant_id", tenantIds);

  if (tenantsError) {
    throwPlatformSchemaMissingError(`Failed to load tenant records: ${tenantsError.message}`);
  }

  const { data: verifications, error: verificationError } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("tenant_id, status, txt_name, txt_value, verified_at")
    .in("tenant_id", tenantIds);

  if (verificationError) {
    throw new HttpError(500, `Failed to load domain verification records: ${verificationError.message}`);
  }

  const verificationByTenant = new Map<string, DomainVerificationRow>();
  for (const row of (verifications ?? []) as DomainVerificationRow[]) {
    verificationByTenant.set(row.tenant_id, row);
  }

  return ((
    tenants ?? []
  ) as Array<{
    tenant_id: string;
    name: string | null;
    allowed_domains: string[];
    business_type: string | null;
    supported_services: string[] | null;
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    business_description: string | null;
  }>).map((tenant) => {
    const verification = verificationByTenant.get(tenant.tenant_id) ?? null;

    return {
      tenant_id: tenant.tenant_id,
      name: tenant.name,
      allowed_domains: tenant.allowed_domains,
      business_profile: normalizeBusinessProfile({
        business_type: tenant.business_type || undefined,
        supported_services: tenant.supported_services as SupportedService[] | undefined,
        support_phone: tenant.support_phone,
        support_email: tenant.support_email,
        support_cta_label: tenant.support_cta_label || undefined,
        business_description: tenant.business_description
      }),
      domain_verification: verification
        ? {
            status: verification.status,
            txt_name: verification.txt_name,
            txt_value: verification.txt_value,
            verified_at: verification.verified_at
          }
        : null
    };
  });
}
