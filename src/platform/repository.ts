import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { supabaseAdmin } from "@/lib/supabase";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "@/platform/auth";
import { clearTenantCache } from "@/tenants/verifyTenant";

function isMissingTableErrorMessage(message: string): boolean {
  return (
    message.includes("Could not find the table 'public.platform_users'") ||
    message.includes("Could not find the table 'public.platform_sessions'") ||
    message.includes("Could not find the table 'public.platform_user_tenants'") ||
    message.includes("Could not find the table 'public.tenant_domain_verifications'") ||
    message.includes("Could not find the table 'public.tenant_sources'") ||
    message.includes("Could not find the table 'public.platform_subscriptions'") ||
    message.includes("Could not find the table 'public.platform_password_resets'") ||
    message.includes('relation "public.platform_users" does not exist') ||
    message.includes('relation "public.platform_sessions" does not exist') ||
    message.includes('relation "public.platform_user_tenants" does not exist') ||
    message.includes('relation "public.tenant_domain_verifications" does not exist') ||
    message.includes('relation "public.tenant_sources" does not exist') ||
    message.includes('relation "public.platform_subscriptions" does not exist') ||
    message.includes('relation "public.platform_password_resets" does not exist') ||
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
    message.includes("column tenants.theme_style does not exist") ||
    message.includes("column tenants.bg_pattern does not exist") ||
    message.includes("column tenants.launcher_icon does not exist") ||
    message.includes("column tenants.window_width does not exist") ||
    message.includes("column tenants.window_height does not exist") ||
    message.includes("column tenants.border_radius does not exist") ||
    message.includes("column tenants.welcome_message does not exist") ||
    message.includes("column tenants.bot_name does not exist") ||
    message.includes("column tenants.bot_avatar_url does not exist") ||
    message.includes("column tenants.quick_replies does not exist") ||
    message.includes("column tenants.ai_tone does not exist") ||
    message.includes("column tenants.notif_enabled does not exist") ||
    message.includes("column tenants.notif_text does not exist") ||
    message.includes("column tenants.notif_animation does not exist") ||
    message.includes("column tenants.notif_chips does not exist") ||
    message.includes("column tenants.header_cta_label does not exist") ||
    message.includes("column tenants.header_cta_notice does not exist") ||
    message.includes("column tenant_domain_verifications.last_checked_at does not exist") ||
    message.includes("column tenant_domain_verifications.last_error does not exist") ||
    message.includes("column tenant_domain_verifications.last_seen_records does not exist") ||
    message.includes('null value in column "password_hash" of relation "platform_users" violates not-null constraint') ||
    message.includes("column platform_users.avatar_url does not exist") ||
    message.includes("column platform_users.avatar_source does not exist") ||
    message.includes("column platform_users.oauth_avatar_url does not exist") ||
    message.includes("column platform_users.oauth_avatar_provider does not exist") ||
    message.includes("column platform_users.google_user_id does not exist") ||
    message.includes("column platform_users.facebook_user_id does not exist") ||
    message.includes("column platform_subscriptions.stripe_customer_id does not exist") ||
    message.includes("column platform_subscriptions.stripe_subscription_id does not exist") ||
    message.includes("column platform_subscriptions.stripe_price_id does not exist") ||
    message.includes("column platform_subscriptions.cancel_at_period_end does not exist") ||
    message.includes("Could not find the table 'public.platform_usage_events'") ||
    message.includes('relation "public.platform_usage_events" does not exist') ||
    message.includes("Could not find the table 'public.visitor_contacts'") ||
    message.includes('relation "public.visitor_contacts" does not exist')
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
  password_hash: string | null;
  avatar_url: string | null;
  avatar_source: string | null;
  oauth_avatar_url: string | null;
  oauth_avatar_provider: PlatformOauthProvider | null;
  google_user_id: string | null;
  facebook_user_id: string | null;
  created_at: string;
};

type PlatformSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
};

type PlatformPasswordResetRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

export type DomainVerificationStatus = "pending" | "txt_not_found" | "txt_mismatch" | "verified";
export type KnowledgeBaseStatus = "pending" | "processing" | "ready" | "warning" | "error";
export type WidgetPosition = "left" | "right";
export type LauncherStyle = "rounded" | "pill" | "square" | "minimal";
export type ThemeStyle = "standard" | "glass" | "clay" | "dark" | "minimal";
export type BgPattern = "none" | "dots" | "grid" | "waves";
export type LauncherIcon = "chat" | "sparkle" | "headset" | "zap" | "heart";
export type AiTone = "friendly" | "professional" | "concise" | "enthusiastic";
export type NotifAnimation = "bounce" | "pulse" | "slide";
export type PlatformOauthProvider = "google" | "facebook";
export type PlatformUserAvatarSource = "initials" | "manual" | PlatformOauthProvider;
export type PlatformAuthProvider = "password" | PlatformOauthProvider;

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
  theme_style: ThemeStyle;
  bg_pattern: BgPattern;
  launcher_icon: LauncherIcon;
  window_width: number;
  window_height: number;
  border_radius: number;
  welcome_message: string;
  bot_name: string;
  bot_avatar_url: string | null;
  quick_replies: string[];
  ai_tone: AiTone;
  notif_enabled: boolean;
  notif_text: string;
  notif_animation: NotifAnimation;
  notif_chips: string[];
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
const defaultQuickReplies = ["How does this work?", "Pricing plans", "Get support"] as const;
const defaultNotifChips = ["I have a question", "Tell me more"] as const;

export type PlatformUserSummary = {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  avatar_source: PlatformUserAvatarSource;
  has_password: boolean;
  auth_providers: PlatformAuthProvider[];
  created_at: string;
};

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

function normalizeThemeStyle(input: string | null | undefined): ThemeStyle {
  const value = input?.trim().toLowerCase();
  if (value === "glass" || value === "clay" || value === "dark" || value === "minimal") {
    return value;
  }
  return "standard";
}

function normalizeBgPattern(input: string | null | undefined): BgPattern {
  const value = input?.trim().toLowerCase();
  if (value === "dots" || value === "grid" || value === "waves") {
    return value;
  }
  return "none";
}

function normalizeLauncherIcon(input: string | null | undefined): LauncherIcon {
  const value = input?.trim().toLowerCase();
  if (value === "sparkle" || value === "headset" || value === "zap" || value === "heart") {
    return value;
  }
  return "chat";
}

function normalizeAiTone(input: string | null | undefined): AiTone {
  const value = input?.trim().toLowerCase();
  if (value === "professional" || value === "concise" || value === "enthusiastic") {
    return value;
  }
  return "friendly";
}

function normalizeNotifAnimation(input: string | null | undefined): NotifAnimation {
  const value = input?.trim().toLowerCase();
  if (value === "pulse" || value === "slide") {
    return value;
  }
  return "bounce";
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

function normalizePlatformOauthProvider(input: string | null | undefined): PlatformOauthProvider | null {
  const value = input?.trim().toLowerCase();
  if (value === "google" || value === "facebook") {
    return value;
  }
  return null;
}

function normalizeAvatarSource(input: string | null | undefined): PlatformUserAvatarSource {
  const value = input?.trim().toLowerCase();
  if (value === "manual" || value === "google" || value === "facebook") {
    return value;
  }
  return "initials";
}

function listAuthProviders(row: PlatformUserRow): PlatformAuthProvider[] {
  const providers: PlatformAuthProvider[] = [];

  if (row.password_hash) {
    providers.push("password");
  }
  if (row.google_user_id) {
    providers.push("google");
  }
  if (row.facebook_user_id) {
    providers.push("facebook");
  }

  return providers;
}

function toPlatformUserSummary(row: PlatformUserRow): PlatformUserSummary {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    avatar_url: normalizeOptionalUrl(row.avatar_url),
    avatar_source: normalizeAvatarSource(row.avatar_source),
    has_password: Boolean(row.password_hash),
    auth_providers: listAuthProviders(row),
    created_at: row.created_at
  };
}

function normalizeStringList(
  input: string[] | null | undefined,
  fallback: readonly string[],
  maxItems: number,
  maxLength: number
): string[] {
  if (!Array.isArray(input)) {
    return [...fallback];
  }
  if (input.length === 0) {
    return [];
  }

  const values = new Set<string>();
  for (const item of input) {
    const normalized = String(item).trim();
    if (!normalized) {
      continue;
    }
    values.add(normalized.slice(0, maxLength));
    if (values.size >= maxItems) {
      break;
    }
  }

  return values.size > 0 ? Array.from(values) : [...fallback];
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

function shouldAddWwwVariant(domain: string): boolean {
  const bareDomain = domain.startsWith("www.") ? domain.slice(4) : domain;
  if (!bareDomain || bareDomain === "localhost") {
    return false;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bareDomain)) {
    return false;
  }

  if (bareDomain.startsWith("[") || bareDomain.endsWith("]") || bareDomain.includes(":")) {
    return false;
  }

  return bareDomain.includes(".");
}

export function buildAllowedDomains(domainInput: string): string[] {
  const primaryDomain = normalizeDomain(domainInput);
  const bareDomain = primaryDomain.startsWith("www.") ? primaryDomain.slice(4) : primaryDomain;
  const domains = [primaryDomain];

  if (primaryDomain.startsWith("www.") && bareDomain && bareDomain !== primaryDomain) {
    domains.push(bareDomain);
  }

  if (shouldAddWwwVariant(primaryDomain) && !primaryDomain.startsWith("www.")) {
    domains.push(`www.${bareDomain}`);
  }

  return Array.from(new Set(domains));
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
  const normalizedHeaderCtaLabel =
    headerCtaLabel && headerCtaLabel.toLowerCase() !== "new" ? headerCtaLabel : "";

  return {
    business_type: input?.business_type?.trim() || "general_travel",
    supported_services: supported,
    support_phone: normalizeOptionalText(input?.support_phone),
    support_email: normalizeOptionalText(input?.support_email),
    support_cta_label: supportCtaLabel || "Connect with a specialist",
    header_cta_label: normalizedHeaderCtaLabel,
    header_cta_notice: headerCtaNotice || "Hi! I am your AI assistant. Ask me anything about your trip.",
    business_description: normalizeOptionalText(input?.business_description),
    primary_color: normalizeHexColor(input?.primary_color, defaultPalette.primary_color),
    user_bubble_color: normalizeHexColor(input?.user_bubble_color, defaultPalette.user_bubble_color),
    bot_bubble_color: normalizeHexColor(input?.bot_bubble_color, defaultPalette.bot_bubble_color),
    font_family: normalizeFontFamily(input?.font_family),
    widget_position: normalizeWidgetPosition(input?.widget_position),
    launcher_style: normalizeLauncherStyle(input?.launcher_style),
    theme_style: normalizeThemeStyle(input?.theme_style),
    bg_pattern: normalizeBgPattern(input?.bg_pattern),
    launcher_icon: normalizeLauncherIcon(input?.launcher_icon),
    window_width: normalizeNumber(input?.window_width, 380, 320, 520),
    window_height: normalizeNumber(input?.window_height, 640, 520, 860),
    border_radius: normalizeNumber(input?.border_radius, 18, 8, 36),
    welcome_message:
      input?.welcome_message?.trim() ||
      buildDefaultWelcomeMessage(defaults?.companyName, supported),
    bot_name: botName || "AeroConcierge",
    bot_avatar_url: normalizeOptionalUrl(input?.bot_avatar_url),
    quick_replies: normalizeStringList(input?.quick_replies, defaultQuickReplies, 6, 60),
    ai_tone: normalizeAiTone(input?.ai_tone),
    notif_enabled: input?.notif_enabled ?? true,
    notif_text: input?.notif_text?.trim() || "👋 Need help?",
    notif_animation: normalizeNotifAnimation(input?.notif_animation),
    notif_chips: normalizeStringList(input?.notif_chips, defaultNotifChips, 4, 40)
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

async function findTenantConflictByAllowedDomains(domains: string[], excludeTenantId?: string): Promise<string | null> {
  if (domains.length === 0) {
    return null;
  }

  const query = supabaseAdmin
    .from("tenants")
    .select("tenant_id")
    .overlaps("allowed_domains", domains);
  const filteredQuery = excludeTenantId ? query.neq("tenant_id", excludeTenantId) : query;
  const { data, error } = await filteredQuery.limit(1).maybeSingle();

  if (error) {
    throw new HttpError(500, `Domain lookup failed: ${error.message}`);
  }

  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
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

async function getPlatformUserByOauthId(
  provider: PlatformOauthProvider,
  providerUserId: string
): Promise<PlatformUserRow | null> {
  const column = provider === "google" ? "google_user_id" : "facebook_user_id";
  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .select("*")
    .eq(column, providerUserId.trim())
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
  return findTenantConflictByAllowedDomains(buildAllowedDomains(domainInput));
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
}): Promise<PlatformUserSummary> {
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
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to create platform user: ${error?.message ?? "Unknown error"}`);
  }

  return toPlatformUserSummary(data as PlatformUserRow);
}

export async function validatePlatformCredentials(input: {
  email: string;
  password: string;
}): Promise<PlatformUserSummary> {
  const user = await getPlatformUserByEmail(input.email);
  if (!user) {
    throw new HttpError(401, "Invalid email or password");
  }

  if (!user.password_hash) {
    throw new HttpError(401, "This account uses social login. Continue with Google or Facebook, or add a password in Account settings.");
  }

  if (!verifyPassword(input.password, user.password_hash)) {
    throw new HttpError(401, "Invalid email or password");
  }

  return toPlatformUserSummary(user);
}

export async function upsertPlatformOauthUser(input: {
  provider: PlatformOauthProvider;
  providerUserId: string;
  email: string;
  fullName: string;
  avatarUrl?: string | null;
}): Promise<PlatformUserSummary> {
  const providerUserId = input.providerUserId.trim();
  if (!providerUserId) {
    throw new HttpError(400, "OAuth provider user ID is required");
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedFullName =
    input.fullName.trim().slice(0, 120) || normalizedEmail.split("@")[0] || "Platform User";
  const normalizedAvatarUrl = normalizeOptionalUrl(input.avatarUrl);

  let user = await getPlatformUserByOauthId(input.provider, providerUserId);
  if (!user) {
    user = await getPlatformUserByEmail(normalizedEmail);
  }

  if (!user) {
    const { data, error } = await supabaseAdmin
      .from("platform_users")
      .insert({
        full_name: normalizedFullName,
        email: normalizedEmail,
        password_hash: null,
        avatar_url: normalizedAvatarUrl,
        avatar_source: normalizedAvatarUrl ? input.provider : "initials",
        oauth_avatar_url: normalizedAvatarUrl,
        oauth_avatar_provider: normalizedAvatarUrl ? input.provider : null,
        google_user_id: input.provider === "google" ? providerUserId : null,
        facebook_user_id: input.provider === "facebook" ? providerUserId : null
      })
      .select("*")
      .single();

    if (error || !data) {
      throwPlatformSchemaMissingError(`Failed to create platform user: ${error?.message ?? "Unknown error"}`);
    }

    return toPlatformUserSummary(data as PlatformUserRow);
  }

  const payload: Record<string, unknown> = {};
  if (user.email !== normalizedEmail) {
    payload.email = normalizedEmail;
  }
  if (normalizedFullName && normalizedFullName !== user.full_name) {
    payload.full_name = normalizedFullName;
  }

  if (input.provider === "google" && user.google_user_id !== providerUserId) {
    payload.google_user_id = providerUserId;
  }
  if (input.provider === "facebook" && user.facebook_user_id !== providerUserId) {
    payload.facebook_user_id = providerUserId;
  }

  if (normalizedAvatarUrl) {
    payload.oauth_avatar_url = normalizedAvatarUrl;
    payload.oauth_avatar_provider = input.provider;

    if (normalizeAvatarSource(user.avatar_source) !== "manual") {
      payload.avatar_url = normalizedAvatarUrl;
      payload.avatar_source = input.provider;
    }
  }

  if (Object.keys(payload).length === 0) {
    return toPlatformUserSummary(user);
  }

  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .update(payload)
    .eq("id", user.id)
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to update platform user: ${error?.message ?? "Unknown error"}`);
  }

  return toPlatformUserSummary(data as PlatformUserRow);
}

export async function hasPlatformPassword(userId: string): Promise<boolean> {
  const user = await getPlatformUserById(userId);
  return Boolean(user?.password_hash);
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

export async function createPlatformPasswordResetToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: string;
}): Promise<void> {
  const { error: cleanupError } = await supabaseAdmin
    .from("platform_password_resets")
    .delete()
    .eq("user_id", input.userId);

  if (cleanupError) {
    throwPlatformSchemaMissingError(`Failed to clear password reset tokens: ${cleanupError.message}`);
  }

  const { error } = await supabaseAdmin
    .from("platform_password_resets")
    .insert({
      user_id: input.userId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      consumed_at: null
    });

  if (error) {
    throwPlatformSchemaMissingError(`Failed to create password reset token: ${error.message}`);
  }
}

async function getPlatformPasswordResetByTokenHash(tokenHash: string): Promise<PlatformPasswordResetRow | null> {
  const { data, error } = await supabaseAdmin
    .from("platform_password_resets")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("consumed_at", null)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load password reset token: ${error.message}`);
  }

  return (data as PlatformPasswordResetRow | null) ?? null;
}

export async function consumePlatformPasswordReset(input: {
  tokenHash: string;
  password: string;
}): Promise<PlatformUserSummary> {
  const reset = await getPlatformPasswordResetByTokenHash(input.tokenHash);
  if (!reset) {
    throw new HttpError(400, "This password reset link is invalid or has expired.");
  }

  if (new Date(reset.expires_at).getTime() < Date.now()) {
    await supabaseAdmin.from("platform_password_resets").delete().eq("id", reset.id);
    throw new HttpError(400, "This password reset link is invalid or has expired.");
  }

  const { error: consumeError } = await supabaseAdmin
    .from("platform_password_resets")
    .update({
      consumed_at: new Date().toISOString()
    })
    .eq("id", reset.id)
    .is("consumed_at", null);

  if (consumeError) {
    throwPlatformSchemaMissingError(`Failed to consume password reset token: ${consumeError.message}`);
  }

  const { data: user, error: userError } = await supabaseAdmin
    .from("platform_users")
    .update({
      password_hash: hashPassword(input.password)
    })
    .eq("id", reset.user_id)
    .select("*")
    .single();

  if (userError || !user) {
    throwPlatformSchemaMissingError(`Failed to update password: ${userError?.message ?? "Unknown error"}`);
  }

  const { error: sessionError } = await supabaseAdmin
    .from("platform_sessions")
    .delete()
    .eq("user_id", reset.user_id);

  if (sessionError) {
    throwPlatformSchemaMissingError(`Failed to revoke existing sessions: ${sessionError.message}`);
  }

  const { error: cleanupError } = await supabaseAdmin
    .from("platform_password_resets")
    .delete()
    .eq("user_id", reset.user_id)
    .neq("id", reset.id);

  if (cleanupError) {
    throwPlatformSchemaMissingError(`Failed to clear password reset tokens: ${cleanupError.message}`);
  }

  return toPlatformUserSummary(user as PlatformUserRow);
}

export async function resolvePlatformSession(
  token: string
): Promise<PlatformUserSummary> {
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

  return toPlatformUserSummary(user);
}

export async function createTenantForUser(input: {
  userId: string;
  companyName: string;
  domain: string;
  businessProfile?: Partial<TenantBusinessProfile>;
}): Promise<{ tenant_id: string; name: string; allowed_domains: string[]; business_profile: TenantBusinessProfile }> {
  const domain = normalizeDomain(input.domain);
  const allowedDomains = buildAllowedDomains(domain);
  const businessProfile = normalizeBusinessProfile(input.businessProfile, {
    companyName: input.companyName
  });

  const existingTenantId = await findTenantConflictByAllowedDomains(allowedDomains);
  if (existingTenantId) {
    throw new HttpError(409, "This domain is already connected to another tenant");
  }

  const tenantId = await generateTenantId(input.companyName, domain);
  const tenantPayload = {
    tenant_id: tenantId,
    name: input.companyName.trim(),
    allowed_domains: allowedDomains,
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
    theme_style: businessProfile.theme_style,
    bg_pattern: businessProfile.bg_pattern,
    launcher_icon: businessProfile.launcher_icon,
    window_width: businessProfile.window_width,
    window_height: businessProfile.window_height,
    border_radius: businessProfile.border_radius,
    welcome_message: businessProfile.welcome_message,
    bot_name: businessProfile.bot_name,
    bot_avatar_url: businessProfile.bot_avatar_url,
    quick_replies: businessProfile.quick_replies,
    ai_tone: businessProfile.ai_tone,
    notif_enabled: businessProfile.notif_enabled,
    notif_text: businessProfile.notif_text,
    notif_animation: businessProfile.notif_animation,
    notif_chips: businessProfile.notif_chips
  };

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert(tenantPayload)
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, theme_style, bg_pattern, launcher_icon, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url, quick_replies, ai_tone, notif_enabled, notif_text, notif_animation, notif_chips"
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
    theme_style: string | null;
    bg_pattern: string | null;
    launcher_icon: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
    quick_replies: string[] | null;
    ai_tone: string | null;
    notif_enabled: boolean | null;
    notif_text: string | null;
    notif_animation: string | null;
    notif_chips: string[] | null;
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
        theme_style: tenantRow.theme_style as ThemeStyle | undefined,
        bg_pattern: tenantRow.bg_pattern as BgPattern | undefined,
        launcher_icon: tenantRow.launcher_icon as LauncherIcon | undefined,
        window_width: tenantRow.window_width || undefined,
        window_height: tenantRow.window_height || undefined,
        border_radius: tenantRow.border_radius || undefined,
        welcome_message: tenantRow.welcome_message || undefined,
        bot_name: tenantRow.bot_name || undefined,
        bot_avatar_url: tenantRow.bot_avatar_url || undefined,
        quick_replies: tenantRow.quick_replies || undefined,
        ai_tone: tenantRow.ai_tone as AiTone | undefined,
        notif_enabled: tenantRow.notif_enabled ?? undefined,
        notif_text: tenantRow.notif_text || undefined,
        notif_animation: tenantRow.notif_animation as NotifAnimation | undefined,
        notif_chips: tenantRow.notif_chips || undefined
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
  const allowedDomains = buildAllowedDomains(domain);

  const conflictingTenantId = await findTenantConflictByAllowedDomains(allowedDomains, input.tenantId);
  if (conflictingTenantId) {
    throw new HttpError(409, "This domain is already connected to another tenant");
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .update({
      allowed_domains: allowedDomains
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
      "name, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, theme_style, bg_pattern, launcher_icon, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url, quick_replies, ai_tone, notif_enabled, notif_text, notif_animation, notif_chips"
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
    theme_style: string | null;
    bg_pattern: string | null;
    launcher_icon: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
    quick_replies: string[] | null;
    ai_tone: string | null;
    notif_enabled: boolean | null;
    notif_text: string | null;
    notif_animation: string | null;
    notif_chips: string[] | null;
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
      theme_style: (patch.theme_style ?? current.theme_style ?? undefined) as ThemeStyle | undefined,
      bg_pattern: (patch.bg_pattern ?? current.bg_pattern ?? undefined) as BgPattern | undefined,
      launcher_icon: (patch.launcher_icon ?? current.launcher_icon ?? undefined) as LauncherIcon | undefined,
      window_width: patch.window_width ?? current.window_width ?? undefined,
      window_height: patch.window_height ?? current.window_height ?? undefined,
      border_radius: patch.border_radius ?? current.border_radius ?? undefined,
      welcome_message: patch.welcome_message ?? current.welcome_message ?? undefined,
      bot_name: patch.bot_name ?? current.bot_name ?? undefined,
      bot_avatar_url: patch.bot_avatar_url ?? current.bot_avatar_url ?? undefined,
      quick_replies: patch.quick_replies ?? current.quick_replies ?? undefined,
      ai_tone: (patch.ai_tone ?? current.ai_tone ?? undefined) as AiTone | undefined,
      notif_enabled: patch.notif_enabled ?? current.notif_enabled ?? undefined,
      notif_text: patch.notif_text ?? current.notif_text ?? undefined,
      notif_animation: (patch.notif_animation ?? current.notif_animation ?? undefined) as NotifAnimation | undefined,
      notif_chips: patch.notif_chips ?? current.notif_chips ?? undefined
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
      theme_style: next.theme_style,
      bg_pattern: next.bg_pattern,
      launcher_icon: next.launcher_icon,
      window_width: next.window_width,
      window_height: next.window_height,
      border_radius: next.border_radius,
      welcome_message: next.welcome_message,
      bot_name: next.bot_name,
      bot_avatar_url: next.bot_avatar_url,
      quick_replies: next.quick_replies,
      ai_tone: next.ai_tone,
      notif_enabled: next.notif_enabled,
      notif_text: next.notif_text,
      notif_animation: next.notif_animation,
      notif_chips: next.notif_chips
    })
    .eq("tenant_id", tenantId);

  if (error) {
    throwPlatformSchemaMissingError(`Failed to update tenant business profile: ${error.message}`);
  }

  clearTenantCache(tenantId);

  return next;
}

export async function deleteTenantById(tenantId: string): Promise<void> {
  // Delete sources first (may not cascade)
  await supabaseAdmin.from("tenant_sources").delete().eq("tenant_id", tenantId);
  await supabaseAdmin.from("tenant_domain_verifications").delete().eq("tenant_id", tenantId);
  await supabaseAdmin.from("platform_user_tenants").delete().eq("tenant_id", tenantId);

  const { error } = await supabaseAdmin
    .from("tenants")
    .delete()
    .eq("tenant_id", tenantId);

  if (error) {
    throw new HttpError(500, `Failed to delete tenant: ${error.message}`);
  }
}

export async function updatePlatformUser(
  userId: string,
  input: {
    full_name?: string;
    email?: string;
    password?: string;
    avatar_url?: string | null;
  }
): Promise<PlatformUserSummary> {
  const currentUser = await getPlatformUserById(userId);
  if (!currentUser) {
    throw new HttpError(404, "User not found");
  }

  const payload: Record<string, unknown> = {};

  if (input.full_name !== undefined) {
    const trimmed = input.full_name.trim();
    if (trimmed.length < 2) throw new HttpError(400, "Name must be at least 2 characters");
    payload.full_name = trimmed;
  }

  if (input.email !== undefined) {
    const normalizedEmail = input.email.trim().toLowerCase();
    const existingUser = await getPlatformUserByEmail(normalizedEmail);
    if (existingUser && existingUser.id !== userId) {
      throw new HttpError(409, "Email is already in use by another account");
    }
    payload.email = normalizedEmail;
  }

  if (input.password !== undefined) {
    if (input.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
    payload.password_hash = hashPassword(input.password);
  }

  if (input.avatar_url !== undefined) {
    const rawAvatarUrl = typeof input.avatar_url === "string" ? input.avatar_url.trim() : "";

    if (input.avatar_url === null || rawAvatarUrl.length === 0) {
      const oauthProvider = normalizePlatformOauthProvider(currentUser.oauth_avatar_provider);
      if (currentUser.oauth_avatar_url && oauthProvider) {
        payload.avatar_url = currentUser.oauth_avatar_url;
        payload.avatar_source = oauthProvider;
      } else {
        payload.avatar_url = null;
        payload.avatar_source = "initials";
      }
    } else {
      const normalizedAvatarUrl = normalizeOptionalUrl(rawAvatarUrl);
      if (!normalizedAvatarUrl) {
        throw new HttpError(400, "Profile image URL must be a valid URL");
      }
      payload.avatar_url = normalizedAvatarUrl;
      payload.avatar_source = "manual";
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "No fields to update");
  }

  const { data, error } = await supabaseAdmin
    .from("platform_users")
    .update(payload)
    .eq("id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to update user: ${error?.message ?? "Unknown error"}`);
  }

  return toPlatformUserSummary(data as PlatformUserRow);
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
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, knowledge_status, knowledge_message, knowledge_last_ingested_at, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, theme_style, bg_pattern, launcher_icon, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url, quick_replies, ai_tone, notif_enabled, notif_text, notif_animation, notif_chips"
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
    theme_style: string | null;
    bg_pattern: string | null;
    launcher_icon: string | null;
    window_width: number | null;
    window_height: number | null;
    border_radius: number | null;
    welcome_message: string | null;
    bot_name: string | null;
    bot_avatar_url: string | null;
    quick_replies: string[] | null;
    ai_tone: string | null;
    notif_enabled: boolean | null;
    notif_text: string | null;
    notif_animation: string | null;
    notif_chips: string[] | null;
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
        theme_style: tenant.theme_style as ThemeStyle | undefined,
        bg_pattern: tenant.bg_pattern as BgPattern | undefined,
        launcher_icon: tenant.launcher_icon as LauncherIcon | undefined,
        window_width: tenant.window_width || undefined,
        window_height: tenant.window_height || undefined,
        border_radius: tenant.border_radius || undefined,
        welcome_message: tenant.welcome_message || undefined,
        bot_name: tenant.bot_name || undefined,
        bot_avatar_url: tenant.bot_avatar_url || undefined,
        quick_replies: tenant.quick_replies || undefined,
        ai_tone: tenant.ai_tone as AiTone | undefined,
        notif_enabled: tenant.notif_enabled ?? undefined,
        notif_text: tenant.notif_text || undefined,
        notif_animation: tenant.notif_animation as NotifAnimation | undefined,
        notif_chips: tenant.notif_chips || undefined
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

// ============================================================================
// SUBSCRIPTIONS
// ============================================================================

type SubscriptionRow = {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  max_tenants: number;
  max_messages_mo: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
};

export type SubscriptionPlan = "trial" | "starter" | "growth" | "enterprise";
export type SubscriptionStatus = "active" | "canceled" | "expired" | "past_due";

export type SubscriptionSummary = {
  id: string;
  user_id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  max_tenants: number;
  max_messages_mo: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
  trial_days_remaining: number | null;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
};

const PLAN_LIMITS: Record<SubscriptionPlan, { max_tenants: number; max_messages_mo: number }> = {
  trial: { max_tenants: 5, max_messages_mo: 100 },
  starter: { max_tenants: 1, max_messages_mo: 10_000 },
  growth: { max_tenants: 5, max_messages_mo: 100_000 },
  enterprise: { max_tenants: 999, max_messages_mo: 1_000_000 }
};

function normalizeSubscriptionPlan(input: string | null | undefined): SubscriptionPlan {
  const value = input?.trim().toLowerCase();
  if (value === "starter" || value === "growth" || value === "enterprise") {
    return value;
  }
  return "trial";
}

function normalizeSubscriptionStatus(input: string | null | undefined): SubscriptionStatus {
  const value = input?.trim().toLowerCase();
  if (value === "canceled" || value === "expired" || value === "past_due") {
    return value;
  }
  return "active";
}

function toSubscriptionSummary(row: SubscriptionRow): SubscriptionSummary {
  const plan = normalizeSubscriptionPlan(row.plan);
  const status = normalizeSubscriptionStatus(row.status);
  let trialDaysRemaining: number | null = null;

  if (plan === "trial" && row.trial_ends_at) {
    const remaining = Math.ceil(
      (new Date(row.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    trialDaysRemaining = Math.max(0, remaining);
  }

  return {
    id: row.id,
    user_id: row.user_id,
    plan,
    status,
    max_tenants: row.max_tenants,
    max_messages_mo: row.max_messages_mo,
    stripe_customer_id: row.stripe_customer_id,
    stripe_subscription_id: row.stripe_subscription_id,
    stripe_price_id: row.stripe_price_id,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
    trial_ends_at: row.trial_ends_at,
    trial_days_remaining: trialDaysRemaining,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    created_at: row.created_at
  };
}

export async function createTrialSubscription(userId: string): Promise<SubscriptionSummary> {
  const limits = PLAN_LIMITS.trial;
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .upsert(
      {
        user_id: userId,
        plan: "trial",
        status: "active",
        max_tenants: limits.max_tenants,
        max_messages_mo: limits.max_messages_mo,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_price_id: null,
        cancel_at_period_end: false,
        trial_ends_at: trialEndsAt,
        current_period_start: new Date().toISOString(),
        current_period_end: trialEndsAt
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to create trial subscription: ${error?.message ?? "Unknown error"}`);
  }

  return toSubscriptionSummary(data as SubscriptionRow);
}

export async function getSubscriptionByUserId(userId: string): Promise<SubscriptionSummary | null> {
  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load subscription: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const row = data as SubscriptionRow;
  const plan = normalizeSubscriptionPlan(row.plan);
  const status = normalizeSubscriptionStatus(row.status);
  const payload: Partial<SubscriptionRow> = {};

  if (plan === "trial") {
    const limits = PLAN_LIMITS.trial;
    if (row.max_tenants !== limits.max_tenants) {
      payload.max_tenants = limits.max_tenants;
    }
    if (row.max_messages_mo !== limits.max_messages_mo) {
      payload.max_messages_mo = limits.max_messages_mo;
    }
  }

  // Auto-expire trial if past trial_ends_at
  if (
    plan === "trial" &&
    status === "active" &&
    row.trial_ends_at &&
    new Date(row.trial_ends_at).getTime() < Date.now()
  ) {
    payload.status = "expired";
  }

  if (Object.keys(payload).length > 0) {
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("platform_subscriptions")
      .update(payload)
      .eq("id", row.id)
      .select("*")
      .single();

    if (!updateError && updated) {
      return toSubscriptionSummary(updated as SubscriptionRow);
    }
  }

  return toSubscriptionSummary(row);
}

export async function getSubscriptionByStripeSubscriptionId(
  stripeSubscriptionId: string
): Promise<SubscriptionSummary | null> {
  const normalizedId = stripeSubscriptionId.trim();
  if (!normalizedId) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .select("*")
    .eq("stripe_subscription_id", normalizedId)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load subscription by Stripe subscription: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return toSubscriptionSummary(data as SubscriptionRow);
}

function mapStripeStatusToLocal(
  status: string | null | undefined
): SubscriptionStatus {
  const value = status?.trim().toLowerCase();
  if (
    value === "past_due" ||
    value === "unpaid" ||
    value === "incomplete" ||
    value === "incomplete_expired"
  ) {
    return "past_due";
  }
  if (value === "canceled") {
    return "canceled";
  }
  return "active";
}

export async function syncSubscriptionFromStripe(input: {
  user_id: string;
  plan: "starter" | "growth";
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  stripe_status: string;
  cancel_at_period_end: boolean;
  current_period_start: string;
  current_period_end: string;
}): Promise<SubscriptionSummary> {
  const limits = PLAN_LIMITS[input.plan];
  const payload = {
    plan: input.plan,
    status: mapStripeStatusToLocal(input.stripe_status),
    max_tenants: limits.max_tenants,
    max_messages_mo: limits.max_messages_mo,
    stripe_customer_id: input.stripe_customer_id,
    stripe_subscription_id: input.stripe_subscription_id,
    stripe_price_id: input.stripe_price_id,
    cancel_at_period_end: input.cancel_at_period_end,
    trial_ends_at: null,
    current_period_start: input.current_period_start,
    current_period_end: input.current_period_end
  };

  const existing = await getSubscriptionByUserId(input.user_id);
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("platform_subscriptions")
      .update(payload)
      .eq("user_id", input.user_id)
      .select("*")
      .single();

    if (error || !data) {
      throwPlatformSchemaMissingError(`Failed to sync Stripe subscription: ${error?.message ?? "Unknown error"}`);
    }

    return toSubscriptionSummary(data as SubscriptionRow);
  }

  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .insert({
      user_id: input.user_id,
      ...payload
    })
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to create Stripe subscription locally: ${error?.message ?? "Unknown error"}`);
  }

  return toSubscriptionSummary(data as SubscriptionRow);
}

export async function updateSubscriptionStatusByStripeSubscriptionId(input: {
  stripe_subscription_id: string;
  status: SubscriptionStatus;
  cancel_at_period_end?: boolean;
  current_period_start?: string;
  current_period_end?: string;
}): Promise<SubscriptionSummary | null> {
  const existing = await getSubscriptionByStripeSubscriptionId(input.stripe_subscription_id);
  if (!existing) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .update({
      status: input.status,
      cancel_at_period_end: input.cancel_at_period_end ?? existing.cancel_at_period_end,
      current_period_start: input.current_period_start ?? existing.current_period_start,
      current_period_end: input.current_period_end ?? existing.current_period_end
    })
    .eq("stripe_subscription_id", input.stripe_subscription_id)
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to update subscription from Stripe status: ${error?.message ?? "Unknown error"}`);
  }

  return toSubscriptionSummary(data as SubscriptionRow);
}

export async function updateSubscriptionPlan(
  userId: string,
  plan: "starter" | "growth"
): Promise<SubscriptionSummary> {
  const limits = PLAN_LIMITS[plan];
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const existing = await getSubscriptionByUserId(userId);

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("platform_subscriptions")
      .update({
        plan,
        status: "active",
        max_tenants: limits.max_tenants,
        max_messages_mo: limits.max_messages_mo,
        stripe_price_id: null,
        stripe_subscription_id: null,
        trial_ends_at: null,
        cancel_at_period_end: false,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString()
      })
      .eq("user_id", userId)
      .select("*")
      .single();

    if (error || !data) {
      throwPlatformSchemaMissingError(`Failed to update subscription: ${error?.message ?? "Unknown error"}`);
    }
    return toSubscriptionSummary(data as SubscriptionRow);
  }

  const { data, error } = await supabaseAdmin
    .from("platform_subscriptions")
    .insert({
      user_id: userId,
      plan,
      status: "active",
      max_tenants: limits.max_tenants,
      max_messages_mo: limits.max_messages_mo,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      stripe_price_id: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString()
    })
    .select("*")
    .single();

  if (error || !data) {
    throwPlatformSchemaMissingError(`Failed to create subscription: ${error?.message ?? "Unknown error"}`);
  }

  return toSubscriptionSummary(data as SubscriptionRow);
}

export function getPlanLimits(plan: SubscriptionPlan) {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.trial;
}

// ============================================================================
// ANALYTICS
// ============================================================================

const ANALYTICS_PAGE_SIZE = 1000;

export type PlatformUsageEventResponseSource =
  | "llm"
  | "flight_engine"
  | "service_flow"
  | "static"
  | "fallback";

export type PlatformUsageEventTokenSource = "provider" | "counted" | "estimated" | "none";

type PlatformUsageEventRow = {
  id: string;
  tenant_id: string;
  chat_id: string;
  device_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  intent: string;
  service: string | null;
  response_source: PlatformUsageEventResponseSource;
  rag_match: boolean | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  token_source: PlatformUsageEventTokenSource;
  latency_ms: number | null;
  had_error: boolean;
  created_at: string;
};

type PlatformAnalyticsJoinedChat = {
  tenant_id: string;
  device_id: string;
};

type PlatformAnalyticsMessageSelectRow = {
  chat_id: string;
  role: "user" | "assistant" | "system";
  created_at: string;
  chats: PlatformAnalyticsJoinedChat | PlatformAnalyticsJoinedChat[] | null;
};

export type PlatformAnalyticsMessageRow = {
  chat_id: string;
  role: "user" | "assistant";
  created_at: string;
  tenant_id: string;
  device_id: string;
};

export type PlatformAnalyticsUsageRow = PlatformUsageEventRow;

export type TenantSubscriptionUsageSnapshot = {
  user_id: string;
  subscription: SubscriptionSummary;
  owned_tenant_ids: string[];
  current_period_user_messages: number;
};

export type PlatformVisitorContactRow = {
  id: string;
  tenant_id: string;
  device_id: string;
  chat_id: string | null;
  full_name: string;
  email: string;
  phone_raw: string;
  phone_normalized: string;
  captured_at: string;
  created_at: string;
  updated_at: string;
};

function normalizeJoinedChat(
  joined: PlatformAnalyticsJoinedChat | PlatformAnalyticsJoinedChat[] | null | undefined
): PlatformAnalyticsJoinedChat | null {
  if (!joined) {
    return null;
  }

  return Array.isArray(joined) ? joined[0] ?? null : joined;
}

export async function insertPlatformUsageEvent(input: {
  tenant_id: string;
  chat_id: string;
  device_id: string;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  intent: string;
  service?: string | null;
  response_source: PlatformUsageEventResponseSource;
  rag_match?: boolean | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  token_source: PlatformUsageEventTokenSource;
  latency_ms?: number | null;
  had_error?: boolean;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("platform_usage_events").insert({
    tenant_id: input.tenant_id,
    chat_id: input.chat_id,
    device_id: input.device_id,
    user_message_id: input.user_message_id ?? null,
    assistant_message_id: input.assistant_message_id ?? null,
    intent: input.intent,
    service: input.service ?? null,
    response_source: input.response_source,
    rag_match: input.rag_match ?? null,
    prompt_tokens: input.prompt_tokens ?? 0,
    completion_tokens: input.completion_tokens ?? 0,
    total_tokens: input.total_tokens ?? 0,
    token_source: input.token_source,
    latency_ms: input.latency_ms ?? null,
    had_error: input.had_error ?? false
  });

  if (error) {
    throwPlatformSchemaMissingError(`Failed to insert usage event: ${error.message}`);
  }
}

export async function listTenantVisitorContacts(input: {
  tenant_id: string;
  query?: string;
  limit: number;
  offset: number;
}): Promise<{ contacts: PlatformVisitorContactRow[]; total: number }> {
  let query = supabaseAdmin
    .from("visitor_contacts")
    .select(
      "id, tenant_id, device_id, chat_id, full_name, email, phone_raw, phone_normalized, captured_at, created_at, updated_at",
      { count: "exact" }
    )
    .eq("tenant_id", input.tenant_id)
    .order("captured_at", { ascending: false });

  const searchTerm = input.query?.trim();
  if (searchTerm) {
    const pattern = `%${searchTerm.replace(/,/g, " ")}%`;
    query = query.or(`full_name.ilike.${pattern},email.ilike.${pattern},phone_raw.ilike.${pattern}`);
  }

  const { data, error, count } = await query.range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load visitor contacts: ${error.message}`);
  }

  return {
    contacts: (data ?? []) as PlatformVisitorContactRow[],
    total: count ?? 0
  };
}

export async function listUserTenantIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("platform_user_tenants")
    .select("tenant_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load user tenant ids: ${error.message}`);
  }

  return ((data ?? []) as Array<{ tenant_id: string | null }>)
    .map((row) => row.tenant_id?.trim() ?? "")
    .filter(Boolean);
}

export async function getPrimaryPlatformUserIdForTenant(tenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("platform_user_tenants")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load tenant owner: ${error.message}`);
  }

  return (data as { user_id?: string | null } | null)?.user_id?.trim() ?? null;
}

export async function countPlatformMessagesInRange(input: {
  tenant_ids: string[];
  start_at: string;
  end_at: string;
  role?: "user" | "assistant" | "system";
}): Promise<number> {
  if (input.tenant_ids.length === 0) {
    return 0;
  }

  let query = supabaseAdmin
    .from("messages")
    .select("id, chats!inner(tenant_id)", { count: "exact", head: true })
    .in("chats.tenant_id", input.tenant_ids)
    .gte("created_at", input.start_at)
    .lte("created_at", input.end_at);

  query = input.role ? query.eq("role", input.role) : query.neq("role", "system");

  const { count, error } = await query;

  if (error) {
    throwPlatformSchemaMissingError(`Failed to count platform messages: ${error.message}`);
  }

  return count ?? 0;
}

export async function getTenantSubscriptionUsageSnapshot(
  tenantId: string
): Promise<TenantSubscriptionUsageSnapshot | null> {
  const userId = await getPrimaryPlatformUserIdForTenant(tenantId);
  if (!userId) {
    return null;
  }

  const [subscription, ownedTenantIds] = await Promise.all([
    getSubscriptionByUserId(userId),
    listUserTenantIds(userId)
  ]);

  if (!subscription) {
    return null;
  }

  const currentPeriodUserMessages = await countPlatformMessagesInRange({
    tenant_ids: ownedTenantIds,
    start_at: subscription.current_period_start,
    end_at: new Date().toISOString(),
    role: "user"
  });

  return {
    user_id: userId,
    subscription,
    owned_tenant_ids: ownedTenantIds,
    current_period_user_messages: currentPeriodUserMessages
  };
}

export async function listPlatformAnalyticsMessages(input: {
  tenant_ids: string[];
  start_at: string;
  end_at: string;
}): Promise<PlatformAnalyticsMessageRow[]> {
  if (input.tenant_ids.length === 0) {
    return [];
  }

  const rows: PlatformAnalyticsMessageRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select("chat_id, role, created_at, chats!inner(tenant_id, device_id)")
      .in("chats.tenant_id", input.tenant_ids)
      .gte("created_at", input.start_at)
      .lte("created_at", input.end_at)
      .neq("role", "system")
      .order("created_at", { ascending: true })
      .range(from, from + ANALYTICS_PAGE_SIZE - 1);

    if (error) {
      throwPlatformSchemaMissingError(`Failed to load analytics messages: ${error.message}`);
    }

    const page = (data ?? []) as PlatformAnalyticsMessageSelectRow[];
    for (const row of page) {
      const joinedChat = normalizeJoinedChat(row.chats);
      if (!joinedChat || (row.role !== "user" && row.role !== "assistant")) {
        continue;
      }

      rows.push({
        chat_id: row.chat_id,
        role: row.role,
        created_at: row.created_at,
        tenant_id: joinedChat.tenant_id,
        device_id: joinedChat.device_id
      });
    }

    if (page.length < ANALYTICS_PAGE_SIZE) {
      break;
    }

    from += ANALYTICS_PAGE_SIZE;
  }

  return rows;
}

export async function listPlatformUsageEvents(input: {
  tenant_ids: string[];
  start_at: string;
  end_at: string;
}): Promise<PlatformAnalyticsUsageRow[]> {
  if (input.tenant_ids.length === 0) {
    return [];
  }

  const rows: PlatformAnalyticsUsageRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("platform_usage_events")
      .select(
        "id, tenant_id, chat_id, device_id, user_message_id, assistant_message_id, intent, service, response_source, rag_match, prompt_tokens, completion_tokens, total_tokens, token_source, latency_ms, had_error, created_at"
      )
      .in("tenant_id", input.tenant_ids)
      .gte("created_at", input.start_at)
      .lte("created_at", input.end_at)
      .order("created_at", { ascending: true })
      .range(from, from + ANALYTICS_PAGE_SIZE - 1);

    if (error) {
      throwPlatformSchemaMissingError(`Failed to load usage events: ${error.message}`);
    }

    const page = (data ?? []) as PlatformUsageEventRow[];
    rows.push(...page);

    if (page.length < ANALYTICS_PAGE_SIZE) {
      break;
    }

    from += ANALYTICS_PAGE_SIZE;
  }

  return rows;
}

export async function getPlatformUsageTrackingStartedAt(
  tenantIds: string[]
): Promise<string | null> {
  if (tenantIds.length === 0) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("platform_usage_events")
    .select("created_at")
    .in("tenant_id", tenantIds)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throwPlatformSchemaMissingError(`Failed to load usage tracking start: ${error.message}`);
  }

  return (data as { created_at?: string } | null)?.created_at ?? null;
}
