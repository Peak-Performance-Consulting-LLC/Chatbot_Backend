import { HttpError } from "@/lib/httpError";
import { getRequestHost } from "@/lib/request";
import { supabaseAdmin } from "@/lib/supabase";
import { assertTenantOwnership, resolvePlatformSession } from "@/platform/repository";

type TenantRow = {
  tenant_id: string;
  name: string | null;
  allowed_domains: string[];
  business_type: string;
  supported_services: Array<"flights" | "hotels" | "cars" | "cruises">;
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
  widget_position: "left" | "right";
  launcher_style: "rounded" | "pill" | "square" | "minimal";
  theme_style: "standard" | "glass" | "clay" | "dark" | "minimal";
  bg_pattern: "none" | "dots" | "grid" | "waves";
  launcher_icon: "chat" | "sparkle" | "headset" | "zap" | "heart";
  window_width: number;
  window_height: number;
  border_radius: number;
  welcome_message: string;
  bot_name: string;
  bot_avatar_url: string | null;
  quick_replies: string[];
  ai_tone: "friendly" | "professional" | "concise" | "enthusiastic";
  notif_enabled: boolean;
  notif_text: string;
  notif_animation: "bounce" | "pulse" | "slide";
  notif_chips: string[];
};

const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;
const TENANT_CACHE_MAX_ENTRIES = 100;
const tenantCache = new Map<string, { data: TenantRow; expiresAt: number }>();
const verificationCache = new Map<string, { verified: boolean; expiresAt: number }>();

function pruneTenantCache() {
  const now = Date.now();
  for (const [key, value] of tenantCache.entries()) {
    if (value.expiresAt <= now) tenantCache.delete(key);
  }
  for (const [key, value] of verificationCache.entries()) {
    if (value.expiresAt <= now) verificationCache.delete(key);
  }
}

function trimTenantCache() {
  while (tenantCache.size > TENANT_CACHE_MAX_ENTRIES) {
    const oldest = tenantCache.keys().next().value;
    if (!oldest) break;
    tenantCache.delete(oldest);
  }
  while (verificationCache.size > TENANT_CACHE_MAX_ENTRIES) {
    const oldest = verificationCache.keys().next().value;
    if (!oldest) break;
    verificationCache.delete(oldest);
  }
}

const defaultServices = ["flights"] as const;
const defaultQuickReplies = ["How does this work?", "Pricing plans", "Get support"] as const;
const defaultNotifChips = ["I have a question", "Tell me more"] as const;

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

function normalizeStringList(input: unknown, fallback: readonly string[], maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(input)) {
    return [...fallback];
  }
  if (input.length === 0) {
    return [];
  }

  const values = new Set<string>();
  for (const item of input) {
    const value = String(item).trim();
    if (!value) {
      continue;
    }
    values.add(value.slice(0, maxLength));
    if (values.size >= maxItems) {
      break;
    }
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

function parseBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization")?.trim();
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authHeader.slice(7).trim() || null;
}

function getClaimedSiteHost(request: Request): string | null {
  const claimedHost = request.headers.get("x-tenant-site-host")?.trim();
  if (claimedHost) {
    return normalizeDomain(claimedHost);
  }

  return getRequestHost(request);
}

export async function getTenantById(tenantId: string): Promise<TenantRow> {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select(
      "tenant_id, name, allowed_domains, business_type, supported_services, support_phone, support_email, support_cta_label, header_cta_label, header_cta_notice, business_description, primary_color, user_bubble_color, bot_bubble_color, font_family, widget_position, launcher_style, theme_style, bg_pattern, launcher_icon, window_width, window_height, border_radius, welcome_message, bot_name, bot_avatar_url, quick_replies, ai_tone, notif_enabled, notif_text, notif_animation, notif_chips"
    )
    .eq("tenant_id", tenantId)
    .single();

  if (error) {
    const missingColumns =
      error.message.includes("column tenants.business_type does not exist") ||
      error.message.includes("column tenants.supported_services does not exist") ||
      error.message.includes("column tenants.primary_color does not exist") ||
      error.message.includes("column tenants.welcome_message does not exist") ||
      error.message.includes("column tenants.theme_style does not exist") ||
      error.message.includes("column tenants.quick_replies does not exist");

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
    header_cta_label?: string | null;
    header_cta_notice?: string | null;
    business_description?: string | null;
    primary_color?: string | null;
    user_bubble_color?: string | null;
    bot_bubble_color?: string | null;
    font_family?: string | null;
    widget_position?: "left" | "right" | null;
    launcher_style?: "rounded" | "pill" | "square" | "minimal" | null;
    theme_style?: "standard" | "glass" | "clay" | "dark" | "minimal" | null;
    bg_pattern?: "none" | "dots" | "grid" | "waves" | null;
    launcher_icon?: "chat" | "sparkle" | "headset" | "zap" | "heart" | null;
    window_width?: number | null;
    window_height?: number | null;
    border_radius?: number | null;
    welcome_message?: string | null;
    bot_name?: string | null;
    bot_avatar_url?: string | null;
    quick_replies?: string[] | null;
    ai_tone?: "friendly" | "professional" | "concise" | "enthusiastic" | null;
    notif_enabled?: boolean | null;
    notif_text?: string | null;
    notif_animation?: "bounce" | "pulse" | "slide" | null;
    notif_chips?: string[] | null;
  };

  const result: TenantRow = {
    tenant_id: row.tenant_id,
    name: row.name,
    allowed_domains: row.allowed_domains,
    business_type: row.business_type?.trim() || "general_travel",
    supported_services: normalizeSupportedServices(row.supported_services),
    support_phone: row.support_phone?.trim() || null,
    support_email: row.support_email?.trim() || null,
    support_cta_label: row.support_cta_label?.trim() || "Connect with a specialist",
    header_cta_label:
      row.header_cta_label?.trim() && row.header_cta_label.trim().toLowerCase() !== "new"
        ? row.header_cta_label.trim()
        : "",
    header_cta_notice: row.header_cta_notice?.trim() || "Hi! I am your AI assistant. Ask me anything about your trip.",
    business_description: row.business_description?.trim() || null,
    primary_color: row.primary_color?.trim() || "#006d77",
    user_bubble_color: row.user_bubble_color?.trim() || "#006d77",
    bot_bubble_color: row.bot_bubble_color?.trim() || "#edf6f9",
    font_family: row.font_family?.trim() || "Manrope",
    widget_position: row.widget_position === "left" ? "left" : "right",
    launcher_style:
      row.launcher_style === "pill" || row.launcher_style === "square" || row.launcher_style === "minimal"
        ? row.launcher_style
        : "rounded",
    theme_style:
      row.theme_style === "glass" || row.theme_style === "clay" || row.theme_style === "dark" || row.theme_style === "minimal"
        ? row.theme_style
        : "standard",
    bg_pattern:
      row.bg_pattern === "dots" || row.bg_pattern === "grid" || row.bg_pattern === "waves"
        ? row.bg_pattern
        : "none",
    launcher_icon:
      row.launcher_icon === "sparkle" || row.launcher_icon === "headset" || row.launcher_icon === "zap" || row.launcher_icon === "heart"
        ? row.launcher_icon
        : "chat",
    window_width: row.window_width && row.window_width > 0 ? row.window_width : 380,
    window_height: row.window_height && row.window_height > 0 ? row.window_height : 640,
    border_radius: row.border_radius && row.border_radius > 0 ? row.border_radius : 18,
    welcome_message: row.welcome_message?.trim() || "Welcome. How can I help today?",
    bot_name: row.bot_name?.trim() || "AeroConcierge",
    bot_avatar_url: row.bot_avatar_url?.trim() || null,
    quick_replies: normalizeStringList(row.quick_replies, defaultQuickReplies, 6, 60),
    ai_tone:
      row.ai_tone === "professional" || row.ai_tone === "concise" || row.ai_tone === "enthusiastic"
        ? row.ai_tone
        : "friendly",
    notif_enabled: row.notif_enabled ?? true,
    notif_text: row.notif_text?.trim() || "👋 Need help?",
    notif_animation: row.notif_animation === "pulse" || row.notif_animation === "slide" ? row.notif_animation : "bounce",
    notif_chips: normalizeStringList(row.notif_chips, defaultNotifChips, 4, 40)
  } as TenantRow;

  pruneTenantCache();
  tenantCache.set(tenantId, { data: result, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  trimTenantCache();

  return result;
}

/** Immediately evict a tenant from the in-process cache.
 *  Call this after any update to business_profile so the widget-config
 *  endpoint returns fresh appearance values on the very next request.
 */
export function clearTenantCache(tenantId: string): void {
  tenantCache.delete(tenantId);
  verificationCache.delete(tenantId);
}

async function isTenantDomainVerified(tenantId: string): Promise<boolean> {
  const cachedVerification = verificationCache.get(tenantId);
  if (cachedVerification && cachedVerification.expiresAt > Date.now()) {
    return cachedVerification.verified;
  }

  const { data, error } = await supabaseAdmin
    .from("tenant_domain_verifications")
    .select("status")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    const missingTable =
      error.message.includes("Could not find the table 'public.tenant_domain_verifications'") ||
      error.message.includes('relation "public.tenant_domain_verifications" does not exist');

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

  const verified = (data as { status?: string }).status === "verified";

  verificationCache.set(tenantId, { verified, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  trimTenantCache();

  return verified;
}

async function allowPortalPreviewAccess(request: Request, tenantId: string): Promise<boolean> {
  const token = parseBearerToken(request);
  if (!token) {
    return false;
  }

  try {
    const user = await resolvePlatformSession(token);
    await assertTenantOwnership(user.id, tenantId);
    return true;
  } catch {
    return false;
  }
}

export async function assertTenantDomainAccess(request: Request, tenantId: string): Promise<TenantRow> {
  const tenant = await getTenantById(tenantId);

  if (await allowPortalPreviewAccess(request, tenantId)) {
    return tenant;
  }

  const requestHost = getClaimedSiteHost(request);

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

  const verified = await isTenantDomainVerified(tenantId);
  if (!verified) {
    throw new HttpError(
      403,
      "You can continue testing your chatbot inside the portal. To use it on your website via widget/embed, please complete DNS verification first."
    );
  }

  return tenant;
}
