import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "@/platform/auth";

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
    message.includes("column tenants.business_description does not exist") ||
    message.includes("column tenants.knowledge_status does not exist") ||
    message.includes("column tenants.knowledge_message does not exist") ||
    message.includes("column tenants.knowledge_last_ingested_at does not exist") ||
    message.includes("column tenants.primary_color does not exist") ||
    message.includes("column tenants.user_bubble_color does not exist") ||
    message.includes("column tenants.bot_bubble_color does not exist") ||
    message.includes("column tenants.font_family does not exist") ||
    message.includes("column tenants.widget_position does not exist") ||
    message.includes("column tenants.launcher_style does not exist") ||
    message.includes("column tenants.window_width does not exist") ||
    message.includes("column tenants.window_height does not exist") ||
    message.includes("column tenants.border_radius does not exist") ||
    message.includes("column tenants.welcome_message does not exist") ||
    message.includes("column tenants.bot_name does not exist") ||
    message.includes("column tenants.bot_avatar_url does not exist") ||
    message.includes("column tenants.header_cta_label does not exist") ||
    message.includes("column tenants.header_cta_notice does not exist") ||
    message.includes("column tenant_domain_verifications.last_checked_at does not exist") ||
    message.includes("column tenant_domain_verifications.last_error does not exist") ||
    message.includes("column tenant_domain_verifications.last_seen_records does not exist")
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

export type DomainVerificationStatus = "pending" | "txt_not_found" | "txt_mismatch" | "verified";
export type KnowledgeBaseStatus = "pending" | "processing" | "ready" | "warning" | "error";
export type WidgetPosition = "left" | "right";
export type LauncherStyle = "rounded" | "pill" | "square" | "minimal";

type DomainVerificationRow = {
  tenant_id: string;
  domain: string;
  txt_name: string;
  txt_value: string;
  status: DomainVerificationStatus;
  last_checked_at: string | null;
  last_error: string | null;
  last_seen_records: string[];
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

const supportedServices = ["flights", "hotels", "cars", "cruises"] as const;
export type SupportedService = (typeof supportedServices)[number];

export type TenantBusinessProfile = {
  business_type: string;
  supported_services: SupportedService[];
  support_phone: string | null;
  support_email: string | null;
  support_cta_label: string;
  header_cta_label: string;
  header_cta_notice: string;
  business_description: string | null;
  primary_color: string;
  user_bubble_color: string;
  bot_bubble_color: string;
  font_family: string;
  widget_position: WidgetPosition;
  launcher_style: LauncherStyle;
  window_width: number;
  window_height: number;
  border_radius: number;
  welcome_message: string;
  bot_name: string;
  bot_avatar_url: string | null;
};

export type TenantKnowledgeState = {
  status: KnowledgeBaseStatus;
  message: string | null;
  last_ingested_at: string | null;
};

export type TenantSummary = {
  tenant_id: string;
  name: string | null;
  allowed_domains: string[];
  business_profile: TenantBusinessProfile;
  knowledge_base: TenantKnowledgeState;
  domain_verification: {
    status: DomainVerificationStatus;
    txt_name: string;
    txt_value: string;
    last_checked_at: string | null;
    last_error: string | null;
    last_seen_records: string[];
    verified_at: string | null;
  } | null;
};

const defaultServices = ["flights"] as const;
const defaultPalette = {
  primary_color: "#006d77",
  user_bubble_color: "#006d77",
  bot_bubble_color: "#edf6f9"
} as const;

export type PlatformSession = {
  token: string;
  expires_at: string;
};

function normalizeSupportedServices(input?: string[] | null): SupportedService[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...defaultServices];
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

function formatSupportedServices(services: SupportedService[]): string {
  const labels = services.map((service) => {
    if (service === "cars") {
      return "car rentals";
    }
    if (service === "cruises") {
      return "cruise planning";
    }
    if (service === "hotels") {
      return "hotel stays";
    }
    return "flight deals";
  });

  if (labels.length === 1) {
    return labels[0] ?? "travel support";
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function buildDefaultWelcomeMessage(companyName?: string | null, services: SupportedService[] = [...defaultServices]): string {
  const company = companyName?.trim() || "our team";
  return `Welcome to ${company}. I can help with ${formatSupportedServices(services)} and support questions from this website.`;
}

function normalizeHexColor(input: string | null | undefined, fallback: string): string {
  const value = input?.trim();
  if (!value) {
    return fallback;
  }

  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (/^#([a-fA-F0-9]{6})$/.test(normalized) || /^#([a-fA-F0-9]{3})$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  return fallback;
}

function normalizeFontFamily(input: string | null | undefined): string {
  const value = input?.trim();
  return value || "Manrope";
}

function normalizeWidgetPosition(input: string | null | undefined): WidgetPosition {
  return input?.trim().toLowerCase() === "left" ? "left" : "right";
}

function normalizeLauncherStyle(input: string | null | undefined): LauncherStyle {
  const value = input?.trim().toLowerCase();
  if (value === "pill" || value === "square" || value === "minimal") {
    return value;
  }
  return "rounded";
}

function normalizeNumber(input: number | string | null | undefined, fallback: number, min: number, max: number): number {
  const value = typeof input === "string" ? Number(input) : input;
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(Number(value))));
}

function normalizeOptionalText(input: string | null | undefined): string | null {
  const value = input?.trim();
  return value || null;
}

function normalizeOptionalUrl(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

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

function normalizeBusinessProfile(
  input: Partial<TenantBusinessProfile> | undefined,
  defaults?: { companyName?: string | null }
): TenantBusinessProfile {
  const supported = normalizeSupportedServices(input?.supported_services as string[] | undefined);
  const supportCtaLabel = input?.support_cta_label?.trim();
  const headerCtaLabel = input?.header_cta_label?.trim();
  const headerCtaNotice = input?.header_cta_notice?.trim();
  const botName = input?.bot_name?.trim();

  return {
    business_type: input?.business_type?.trim() || "general_travel",
    supported_services: supported,
    support_phone: normalizeOptionalText(input?.support_phone),
    support_email: normalizeOptionalText(input?.support_email),
    support_cta_label: supportCtaLabel || "Connect with a specialist",
    header_cta_label: headerCtaLabel || "New",
    header_cta_notice: headerCtaNotice || "Hi! I am your AI assistant. Ask me anything about your trip.",
    business_description: normalizeOptionalText(input?.business_description),
    primary_color: normalizeHexColor(input?.primary_color, defaultPalette.primary_color),
    user_bubble_color: normalizeHexColor(input?.user_bubble_color, defaultPalette.user_bubble_color),
    bot_bubble_color: normalizeHexColor(input?.bot_bubble_color, defaultPalette.bot_bubble_color),
    font_family: normalizeFontFamily(input?.font_family),
    widget_position: normalizeWidgetPosition(input?.widget_position),
    launcher_style: normalizeLauncherStyle(input?.launcher_style),
    window_width: normalizeNumber(input?.window_width, 380, 320, 520),
    window_height: normalizeNumber(input?.window_height, 640, 520, 860),
    border_radius: normalizeNumber(input?.border_radius, 18, 8, 36),
    welcome_message:
      input?.welcome_message?.trim() ||
      buildDefaultWelcomeMessage(defaults?.companyName, supported),
    bot_name: botName || "AeroConcierge",
    bot_avatar_url: normalizeOptionalUrl(input?.bot_avatar_url)
  };
}

function normalizeKnowledgeState(input: {
  status?: string | null;
  message?: string | null;
  last_ingested_at?: string | null;
}): TenantKnowledgeState {
  const status = input.status?.trim().toLowerCase();
  const normalizedStatus: KnowledgeBaseStatus =
    status === "processing" || status === "ready" || status === "warning" || status === "error"
      ? status
      : "pending";

  return {
    status: normalizedStatus,
    message: normalizeOptionalText(input.message),
    last_ingested_at: input.last_ingested_at ?? null
  };
}

function mapDomainVerification(row: DomainVerificationRow | null) {
  if (!row) {
    return null;
  }

  return {
    status: row.status,
    txt_name: row.txt_name,
    txt_value: row.txt_value,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    last_seen_records: Array.isArray(row.last_seen_records) ? row.last_seen_records : [],
    verified_at: row.verified_at
  };
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

export async function resolvePlatformSession(
  token: string
): Promise<Pick<PlatformUserRow, "id" | "email" | "full_name" | "created_at">> {
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
  const businessProfile = normalizeBusinessProfile(input.businessProfile, {
    companyName: input.companyName
  });

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
    header_cta_label: businessProfile.header_cta_label,
    header_cta_notice: businessProfile.header_cta_notice,
    business_description: businessProfile.business_description,
    knowledge_status: "pending",
    knowledge_message: "Knowledge base ingestion will begin as soon as the initial website sources are processed.",
    knowledge_last_ingested_at: null,
    primary_color: businessProfile.primary_color,
    user_bubble_color: businessProfile.user_bubble_color,
    bot_bubble_color: businessProfile.bot_bubble_color,
    font_family: businessProfile.font_family,
    widget_position: businessProfile.widget_position,
    launcher_style: businessProfile.launcher_style,
    window_width: businessProfile.window_width,
    window_height: businessProfile.window_height,
    border_radius: businessProfile.border_radius,
    welcome_message: businessProfile.welcome_message,
    bot_name: businessProfile.bot_name,
    bot_avatar_url: businessProfile.bot_avatar_url
  };

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert(tenantPayload)
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url"
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
    business_type: string | null;
    supported_services: string[] | null;
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    header_cta_label: string | null;
    header_cta_notice: string | null;
    business_description: string | null;
    primary_color: string | null;
    user_bubble_color: string | null;
    bot_bubble_color: string | null;
    font_family: string | null;
    widget_position: string | null;
    launcher_style: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
  };

  return {
    tenant_id: tenantRow.tenant_id,
    name: tenantRow.name,
    allowed_domains: tenantRow.allowed_domains,
    business_profile: normalizeBusinessProfile(
      {
        business_type: tenantRow.business_type || undefined,
        supported_services: tenantRow.supported_services as SupportedService[] | undefined,
        support_phone: tenantRow.support_phone,
        support_email: tenantRow.support_email,
        support_cta_label: tenantRow.support_cta_label || undefined,
        header_cta_label: tenantRow.header_cta_label || undefined,
        header_cta_notice: tenantRow.header_cta_notice || undefined,
        business_description: tenantRow.business_description,
        primary_color: tenantRow.primary_color || undefined,
        user_bubble_color: tenantRow.user_bubble_color || undefined,
        bot_bubble_color: tenantRow.bot_bubble_color || undefined,
        font_family: tenantRow.font_family || undefined,
        widget_position: tenantRow.widget_position as WidgetPosition | undefined,
        launcher_style: tenantRow.launcher_style as LauncherStyle | undefined,
        window_width: tenantRow.window_width || undefined,
        window_height: tenantRow.window_height || undefined,
        border_radius: tenantRow.border_radius || undefined,
        welcome_message: tenantRow.welcome_message || undefined,
        bot_name: tenantRow.bot_name || undefined,
        bot_avatar_url: tenantRow.bot_avatar_url || undefined
      },
      { companyName: tenantRow.name }
    )
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
    last_checked_at: null,
    last_error: null,
    last_seen_records: [] as string[],
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

export async function updateDomainVerificationStatus(input: {
  tenantId: string;
  status: DomainVerificationStatus;
  records?: string[];
  errorMessage?: string | null;
}): Promise<DomainVerificationRow> {
  const payload = {
    status: input.status,
    last_checked_at: new Date().toISOString(),
    last_error: normalizeOptionalText(input.errorMessage),
    last_seen_records: Array.from(new Set((input.records ?? []).map((record) => record.trim()).filter(Boolean))),
    verified_at: input.status === "verified" ? new Date().toISOString() : null
  };

  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .update(payload)
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, `Failed to update domain verification status: ${error?.message ?? "Unknown error"}`);
  }

  return data as DomainVerificationRow;
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

export async function updateTenantKnowledgeState(
  tenantId: string,
  patch: {
    status: KnowledgeBaseStatus;
    message?: string | null;
    last_ingested_at?: string | null;
  }
): Promise<TenantKnowledgeState> {
  const payload = {
    knowledge_status: patch.status,
    knowledge_message: normalizeOptionalText(patch.message),
    knowledge_last_ingested_at: patch.last_ingested_at ?? null
  };

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .update(payload)
    .eq("tenant_id", tenantId)
    .select("knowledge_status, knowledge_message, knowledge_last_ingested_at")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to update tenant knowledge status: ${error?.message ?? "Unknown error"}`);
  }

  return normalizeKnowledgeState({
    status: (data as { knowledge_status?: string | null }).knowledge_status,
    message: (data as { knowledge_message?: string | null }).knowledge_message ?? null,
    last_ingested_at: (data as { knowledge_last_ingested_at?: string | null }).knowledge_last_ingested_at ?? null
  });
}

export async function updateTenantBusinessProfile(
  tenantId: string,
  patch: Partial<TenantBusinessProfile>
): Promise<TenantBusinessProfile> {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("tenants")
    .select(
      "name, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url"
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
    name: string | null;
    business_type: string | null;
    supported_services: string[] | null;
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    header_cta_label: string | null;
    header_cta_notice: string | null;
    business_description: string | null;
    primary_color: string | null;
    user_bubble_color: string | null;
    bot_bubble_color: string | null;
    font_family: string | null;
    widget_position: string | null;
    launcher_style: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
  };

  const next = normalizeBusinessProfile(
    {
      business_type: patch.business_type ?? current.business_type ?? undefined,
      supported_services:
        (patch.supported_services as SupportedService[] | undefined) ??
        (current.supported_services as SupportedService[] | null) ??
        undefined,
      support_phone: patch.support_phone ?? current.support_phone,
      support_email: patch.support_email ?? current.support_email,
      support_cta_label: patch.support_cta_label ?? current.support_cta_label ?? undefined,
      header_cta_label: patch.header_cta_label ?? current.header_cta_label ?? undefined,
      header_cta_notice: patch.header_cta_notice ?? current.header_cta_notice ?? undefined,
      business_description: patch.business_description ?? current.business_description,
      primary_color: patch.primary_color ?? current.primary_color ?? undefined,
      user_bubble_color: patch.user_bubble_color ?? current.user_bubble_color ?? undefined,
      bot_bubble_color: patch.bot_bubble_color ?? current.bot_bubble_color ?? undefined,
      font_family: patch.font_family ?? current.font_family ?? undefined,
      widget_position: (patch.widget_position ?? current.widget_position ?? undefined) as WidgetPosition | undefined,
      launcher_style: (patch.launcher_style ?? current.launcher_style ?? undefined) as LauncherStyle | undefined,
      window_width: patch.window_width ?? current.window_width ?? undefined,
      window_height: patch.window_height ?? current.window_height ?? undefined,
      border_radius: patch.border_radius ?? current.border_radius ?? undefined,
      welcome_message: patch.welcome_message ?? current.welcome_message ?? undefined,
      bot_name: patch.bot_name ?? current.bot_name ?? undefined,
      bot_avatar_url: patch.bot_avatar_url ?? current.bot_avatar_url ?? undefined
    },
    { companyName: current.name }
  );

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({
      business_type: next.business_type,
      supported_services: next.supported_services,
      support_phone: next.support_phone,
      support_email: next.support_email,
      support_cta_label: next.support_cta_label,
      header_cta_label: next.header_cta_label,
      header_cta_notice: next.header_cta_notice,
      business_description: next.business_description,
      primary_color: next.primary_color,
      user_bubble_color: next.user_bubble_color,
      bot_bubble_color: next.bot_bubble_color,
      font_family: next.font_family,
      widget_position: next.widget_position,
      launcher_style: next.launcher_style,
      window_width: next.window_width,
      window_height: next.window_height,
      border_radius: next.border_radius,
      welcome_message: next.welcome_message,
      bot_name: next.bot_name,
      bot_avatar_url: next.bot_avatar_url
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
    throwPlatformSchemaMissingError(`Failed to load user tenants: ${linksError.message}`);
  }

  const tenantIds = (links ?? []).map((item) => (item as { tenant_id: string }).tenant_id);
  if (tenantIds.length === 0) {
    return [];
  }

  const { data: tenants, error: tenantsError } = await supabaseAdmin
    .from("tenants")
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, knowledge_status, knowledge_message, knowledge_last_ingested_at, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url"
    )
    .in("tenant_id", tenantIds);

  if (tenantsError) {
    throwPlatformSchemaMissingError(`Failed to load tenant records: ${tenantsError.message}`);
  }

  const { data: verifications, error: verificationError } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("tenant_id, domain, txt_name, txt_value, status, last_checked_at, last_error, last_seen_records, verified_at, created_at")
    .in("tenant_id", tenantIds);

  if (verificationError) {
    throwPlatformSchemaMissingError(`Failed to load domain verification records: ${verificationError.message}`);
  }

  const verificationByTenant = new Map<string, DomainVerificationRow>();
  for (const row of (verifications ?? []) as DomainVerificationRow[]) {
    verificationByTenant.set(row.tenant_id, row);
  }

  return ((tenants ?? []) as Array<{
    tenant_id: string;
    name: string | null;
    allowed_domains: string[];
    business_type: string | null;
    supported_services: string[] | null;
    support_phone: string | null;
    support_email: string | null;
    support_cta_label: string | null;
    header_cta_label: string | null;
    header_cta_notice: string | null;
    business_description: string | null;
    knowledge_status: string | null;
    knowledge_message: string | null;
    knowledge_last_ingested_at: string | null;
    primary_color: string | null;
    user_bubble_color: string | null;
    bot_bubble_color: string | null;
    font_family: string | null;
    widget_position: string | null;
    launcher_style: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
  }>).map((tenant) => ({
    tenant_id: tenant.tenant_id,
    name: tenant.name,
    allowed_domains: tenant.allowed_domains,
    business_profile: normalizeBusinessProfile(
      {
        business_type: tenant.business_type || undefined,
        supported_services: tenant.supported_services as SupportedService[] | undefined,
        support_phone: tenant.support_phone,
        support_email: tenant.support_email,
        support_cta_label: tenant.support_cta_label || undefined,
        header_cta_label: tenant.header_cta_label || undefined,
        header_cta_notice: tenant.header_cta_notice || undefined,
        business_description: tenant.business_description,
        primary_color: tenant.primary_color || undefined,
        user_bubble_color: tenant.user_bubble_color || undefined,
        bot_bubble_color: tenant.bot_bubble_color || undefined,
        font_family: tenant.font_family || undefined,
        widget_position: tenant.widget_position as WidgetPosition | undefined,
        launcher_style: tenant.launcher_style as LauncherStyle | undefined,
        window_width: tenant.window_width || undefined,
        window_height: tenant.window_height || undefined,
        border_radius: tenant.border_radius || undefined,
        welcome_message: tenant.welcome_message || undefined,
        bot_name: tenant.bot_name || undefined,
        bot_avatar_url: tenant.bot_avatar_url || undefined
      },
      { companyName: tenant.name }
    ),
    knowledge_base: normalizeKnowledgeState({
      status: tenant.knowledge_status,
      message: tenant.knowledge_message,
      last_ingested_at: tenant.knowledge_last_ingested_at
    }),
    domain_verification: mapDomainVerification(verificationByTenant.get(tenant.tenant_id) ?? null)
  }));
}
