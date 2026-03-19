import { randomBytes } from "crypto";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { ingestKnowledgeForTenant, type TenantSourceInput } from "@/rag/ingest";
import {
  assertTenantOwnership,
  createPlatformSession,
  createTrialSubscription,
  createPlatformUser,
  createTenantForUser,
  deletePlatformUserById,
  deleteTenantById,
  findTenantIdByDomain,
  getDomainVerification,
  getSubscriptionByUserId,
  listTenantSources,
  listUserTenants,
  replaceTenantSources,
  resolvePlatformSession,
  type SubscriptionSummary,
  type SupportedService,
  type TenantBusinessProfile,
  type TenantSummary,
  updateDomainVerificationStatus,
  updateSubscriptionPlan,
  updateTenantAllowedDomain,
  updateTenantBusinessProfile,
  updateTenantKnowledgeState,
  updatePlatformUser,
  upsertPlatformOauthUser,
  upsertDomainVerification,
  validatePlatformCredentials
} from "@/platform/repository";
import type { PlatformOauthProfile } from "@/platform/oauth";
import { verifyDnsTxtRecord } from "@/platform/dns";
import { buildWidgetConfig } from "@/platform/widget";

function normalizeWebsiteUrl(input: string): URL {
  const trimmed = input.trim();
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      throw new HttpError(400, "Invalid website URL");
    }
  }
}

function buildTenantSources(input: {
  website_url: string;
  sitemap_url?: string;
  faq_text?: string;
  doc_urls?: string[];
}): TenantSourceInput[] {
  const sources: TenantSourceInput[] = [
    {
      source_type: "url",
      source_value: input.website_url
    }
  ];

  if (input.sitemap_url?.trim()) {
    sources.push({
      source_type: "sitemap",
      source_value: input.sitemap_url.trim()
    });
  }

  for (const url of input.doc_urls ?? []) {
    if (url.trim()) {
      sources.push({
        source_type: "url",
        source_value: url.trim()
      });
    }
  }

  if (input.faq_text?.trim()) {
    sources.push({
      source_type: "faq",
      source_value: input.faq_text.trim()
    });
  }

  return sources;
}

function buildDomainVerificationPayload(domain: string) {
  const token = randomBytes(16).toString("hex");
  return {
    domain,
    txt_name: `_aeroconcierge.${domain}`,
    txt_value: `ac-verify=${token}`
  };
}

function shouldAutoIngestOnSignup(): boolean {
  const configured = getEnv().PLATFORM_AUTO_INGEST_ON_SIGNUP?.trim().toLowerCase();
  if (configured === "false" || configured === "0" || configured === "no") {
    return false;
  }

  return true;
}

function shouldAutoIngestOnSourceUpdate(): boolean {
  const configured = getEnv().PLATFORM_AUTO_INGEST_ON_SOURCE_UPDATE?.trim().toLowerCase();
  if (configured === "false" || configured === "0" || configured === "no") {
    return false;
  }

  return true;
}

function summarizeIngestion(result: {
  inserted_chunks: number;
  fetched_documents: number;
  skipped_documents: number;
  errors: string[];
}) {
  if (result.errors.length > 0 && result.inserted_chunks === 0) {
    return {
      status: "error" as const,
      message: result.errors[0] || "Knowledge base ingestion failed."
    };
  }

  if (result.errors.length > 0) {
    return {
      status: "warning" as const,
      message:
        `Knowledge base updated with ${result.inserted_chunks} chunk${result.inserted_chunks === 1 ? "" : "s"}. ` +
        `Some sources still need attention.`
    };
  }

  if (result.inserted_chunks > 0) {
    return {
      status: "ready" as const,
      message:
        `Knowledge base ready. Indexed ${result.inserted_chunks} chunk${result.inserted_chunks === 1 ? "" : "s"} ` +
        `from ${result.fetched_documents} document${result.fetched_documents === 1 ? "" : "s"}.`
    };
  }

  return {
    status: "warning" as const,
    message: "No usable content was extracted yet. Review your website and sitemap URLs, then retry indexing."
  };
}

function buildDnsStatusMessage(status: "pending" | "txt_not_found" | "txt_mismatch" | "verified") {
  switch (status) {
    case "verified":
      return "DNS ownership is verified. Your live website widget is ready.";
    case "txt_not_found":
      return "TXT record not found. Add the verification record in your DNS settings and try again.";
    case "txt_mismatch":
      return "TXT record found, but the value does not match this workspace. Update the TXT value and retry verification.";
    default:
      return "Please add the TXT verification record to your DNS settings to connect the chatbot widget to your website.";
  }
}

function toPlatformTenant(tenant: TenantSummary) {
  const isVerified = tenant.domain_verification?.status === "verified";
  return {
    ...tenant,
    widget: buildWidgetConfig({
      tenantId: tenant.tenant_id,
      domainVerified: isVerified,
      businessProfile: tenant.business_profile
    })
  };
}

function formatSubscriptionPlan(plan: SubscriptionSummary["plan"]): string {
  switch (plan) {
    case "starter":
      return "Starter";
    case "growth":
      return "Growth";
    case "enterprise":
      return "Enterprise";
    default:
      return "Trial";
  }
}

async function ensureUserSubscription(userId: string): Promise<SubscriptionSummary> {
  const existing = await getSubscriptionByUserId(userId);
  if (existing) {
    return existing;
  }

  return createTrialSubscription(userId);
}

async function getOwnedTenantSummary(userId: string, tenantId: string) {
  const tenants = await listUserTenants(userId);
  const tenant = tenants.find((item) => item.tenant_id === tenantId);
  if (!tenant) {
    throw new HttpError(404, "Tenant not found");
  }
  return tenant;
}

async function runProvisioningIngest(input: {
  tenantId: string;
  sources: TenantSourceInput[];
  shouldAutoIngest?: boolean;
  processingMessage?: string;
  pendingMessage?: string;
}) {
  if (input.sources.length === 0) {
    await updateTenantKnowledgeState(input.tenantId, {
      status: "pending",
      message: "Add a website, sitemap, FAQ, or document source to start building the knowledge base.",
      last_ingested_at: null
    });

    return {
      tenant_id: input.tenantId,
      inserted_chunks: 0,
      fetched_documents: 0,
      skipped_documents: 0,
      errors: []
    };
  }

  if (!(input.shouldAutoIngest ?? shouldAutoIngestOnSignup())) {
    await updateTenantKnowledgeState(input.tenantId, {
      status: "pending",
      message: input.pendingMessage ?? "Knowledge sources were saved. Start indexing to make the chatbot ready.",
      last_ingested_at: null
    });

    return {
      tenant_id: input.tenantId,
      inserted_chunks: 0,
      fetched_documents: 0,
      skipped_documents: 0,
      errors: []
    };
  }

  await updateTenantKnowledgeState(input.tenantId, {
    status: "processing",
    message:
      input.processingMessage ??
      "Reading sitemap URLs, child sitemaps, pages, docs, and policies to build tenant knowledge chunks.",
    last_ingested_at: null
  });

  let result;
  try {
    result = await ingestKnowledgeForTenant({
      tenant_id: input.tenantId,
      sources: input.sources,
      replace: true,
      max_sitemap_urls: 40,
      max_chunks: 700
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTenantKnowledgeState(input.tenantId, {
      status: "error",
      message,
      last_ingested_at: null
    });

    return {
      tenant_id: input.tenantId,
      inserted_chunks: 0,
      fetched_documents: 0,
      skipped_documents: 0,
      errors: [message]
    };
  }

  const summary = summarizeIngestion(result);
  await updateTenantKnowledgeState(input.tenantId, {
    status: summary.status,
    message: summary.message,
    last_ingested_at: new Date().toISOString()
  });

  return result;
}

export async function signupPlatformTenant(input: {
  full_name: string;
  email: string;
  password: string;
  company_name: string;
  website_url: string;
  sitemap_url?: string;
  faq_text?: string;
  doc_urls?: string[];
  business_type?: string;
  supported_services?: SupportedService[];
  support_phone?: string;
  support_email?: string;
  support_cta_label?: string;
  business_description?: string;
}) {
  const website = normalizeWebsiteUrl(input.website_url);
  const domain = website.hostname.toLowerCase();

  const existingTenantId = await findTenantIdByDomain(domain);
  if (existingTenantId) {
    throw new HttpError(409, "This domain is already connected to another workspace");
  }

  const user = await createPlatformUser({
    fullName: input.full_name,
    email: input.email,
    password: input.password
  });

  let tenant;
  try {
    await createTrialSubscription(user.id);
    tenant = await createTenantForUser({
      userId: user.id,
      companyName: input.company_name,
      domain,
      businessProfile: {
        business_type: input.business_type,
        supported_services: input.supported_services,
        support_phone: input.support_phone,
        support_email: input.support_email,
        support_cta_label: input.support_cta_label,
        business_description: input.business_description
      }
    });
  } catch (error) {
    await deletePlatformUserById(user.id).catch(() => undefined);
    throw error;
  }

  const verificationPayload = buildDomainVerificationPayload(domain);
  await upsertDomainVerification({
    tenantId: tenant.tenant_id,
    domain,
    txtName: verificationPayload.txt_name,
    txtValue: verificationPayload.txt_value
  });

  const sources = buildTenantSources({
    website_url: website.toString(),
    sitemap_url: input.sitemap_url,
    faq_text: input.faq_text,
    doc_urls: input.doc_urls
  });

  await replaceTenantSources(
    tenant.tenant_id,
    sources.map((source) => ({
      source_type: source.source_type,
      source_value: source.source_value
    }))
  );

  const ingest = await runProvisioningIngest({
    tenantId: tenant.tenant_id,
    sources
  });

  const session = await createPlatformSession(user.id);
  const latestTenant = await getOwnedTenantSummary(user.id, tenant.tenant_id);

  return {
    user,
    token: session.token,
    expires_at: session.expires_at,
    tenant: toPlatformTenant(latestTenant),
    ingest
  };
}

export async function createPlatformWorkspace(input: {
  token: string;
  company_name: string;
  website_url: string;
  sitemap_url?: string;
  faq_text?: string;
  doc_urls?: string[];
  business_type?: string;
  supported_services?: SupportedService[];
  support_phone?: string;
  support_email?: string;
  support_cta_label?: string;
  business_description?: string;
}) {
  const user = await resolvePlatformSession(input.token);
  const website = normalizeWebsiteUrl(input.website_url);
  const domain = website.hostname.toLowerCase();

  const existingTenantId = await findTenantIdByDomain(domain);
  if (existingTenantId) {
    throw new HttpError(409, "This domain is already connected to another workspace");
  }

  await enforcePlanLimits(user.id, "create_tenant");

  const tenant = await createTenantForUser({
    userId: user.id,
    companyName: input.company_name,
    domain,
    businessProfile: {
      business_type: input.business_type,
      supported_services: input.supported_services,
      support_phone: input.support_phone,
      support_email: input.support_email,
      support_cta_label: input.support_cta_label,
      business_description: input.business_description
    }
  });

  const verificationPayload = buildDomainVerificationPayload(domain);
  await upsertDomainVerification({
    tenantId: tenant.tenant_id,
    domain,
    txtName: verificationPayload.txt_name,
    txtValue: verificationPayload.txt_value
  });

  const sources = buildTenantSources({
    website_url: website.toString(),
    sitemap_url: input.sitemap_url,
    faq_text: input.faq_text,
    doc_urls: input.doc_urls
  });

  await replaceTenantSources(
    tenant.tenant_id,
    sources.map((source) => ({
      source_type: source.source_type,
      source_value: source.source_value
    }))
  );

  const ingest = await runProvisioningIngest({
    tenantId: tenant.tenant_id,
    sources
  });

  const latestTenant = await getOwnedTenantSummary(user.id, tenant.tenant_id);

  return {
    tenant: toPlatformTenant(latestTenant),
    ingest
  };
}

export async function updatePlatformTenantProfile(input: {
  token: string;
  tenant_id: string;
  business_type?: string;
  supported_services?: SupportedService[];
  support_phone?: string;
  support_email?: string;
  support_cta_label?: string;
  header_cta_label?: string;
  header_cta_notice?: string;
  business_description?: string;
  primary_color?: string;
  user_bubble_color?: string;
  bot_bubble_color?: string;
  font_family?: string;
  widget_position?: "left" | "right";
  launcher_style?: "rounded" | "pill" | "square" | "minimal";
  theme_style?: "standard" | "glass" | "clay" | "dark" | "minimal";
  bg_pattern?: "none" | "dots" | "grid" | "waves";
  launcher_icon?: "chat" | "sparkle" | "headset" | "zap" | "heart";
  window_width?: number;
  window_height?: number;
  border_radius?: number;
  welcome_message?: string;
  bot_name?: string;
  bot_avatar_url?: string;
  quick_replies?: string[];
  ai_tone?: "friendly" | "professional" | "concise" | "enthusiastic";
  notif_enabled?: boolean;
  notif_text?: string;
  notif_animation?: "bounce" | "pulse" | "slide";
  notif_chips?: string[];
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  await updateTenantBusinessProfile(input.tenant_id, {
    business_type: input.business_type,
    supported_services: input.supported_services,
    support_phone: input.support_phone,
    support_email: input.support_email,
    support_cta_label: input.support_cta_label,
    header_cta_label: input.header_cta_label,
    header_cta_notice: input.header_cta_notice,
    business_description: input.business_description,
    primary_color: input.primary_color,
    user_bubble_color: input.user_bubble_color,
    bot_bubble_color: input.bot_bubble_color,
    font_family: input.font_family,
    widget_position: input.widget_position,
    launcher_style: input.launcher_style,
    theme_style: input.theme_style,
    bg_pattern: input.bg_pattern,
    launcher_icon: input.launcher_icon,
    window_width: input.window_width,
    window_height: input.window_height,
    border_radius: input.border_radius,
    welcome_message: input.welcome_message,
    bot_name: input.bot_name,
    bot_avatar_url: input.bot_avatar_url,
    quick_replies: input.quick_replies,
    ai_tone: input.ai_tone,
    notif_enabled: input.notif_enabled,
    notif_text: input.notif_text,
    notif_animation: input.notif_animation,
    notif_chips: input.notif_chips
  } satisfies Partial<TenantBusinessProfile>);

  const tenant = await getOwnedTenantSummary(user.id, input.tenant_id);
  return {
    tenant: toPlatformTenant(tenant)
  };
}

export async function updatePlatformTenantDomain(input: {
  token: string;
  tenant_id: string;
  website_url: string;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  const website = normalizeWebsiteUrl(input.website_url);
  const domain = website.hostname.toLowerCase();

  await updateTenantAllowedDomain({
    tenantId: input.tenant_id,
    domain
  });

  const verificationPayload = buildDomainVerificationPayload(domain);
  await upsertDomainVerification({
    tenantId: input.tenant_id,
    domain,
    txtName: verificationPayload.txt_name,
    txtValue: verificationPayload.txt_value
  });

  const tenant = await getOwnedTenantSummary(user.id, input.tenant_id);
  return {
    tenant: toPlatformTenant(tenant)
  };
}

export async function loginPlatformUser(input: { email: string; password: string }) {
  const user = await validatePlatformCredentials(input);
  const session = await createPlatformSession(user.id);
  const tenants = await listUserTenants(user.id);

  return {
    user,
    token: session.token,
    expires_at: session.expires_at,
    tenants: tenants.map(toPlatformTenant)
  };
}

export async function loginPlatformUserWithOAuth(input: PlatformOauthProfile) {
  const user = await upsertPlatformOauthUser({
    provider: input.provider,
    providerUserId: input.provider_user_id,
    email: input.email,
    fullName: input.full_name,
    avatarUrl: input.avatar_url
  });
  const session = await createPlatformSession(user.id);
  const tenants = await listUserTenants(user.id);

  return {
    user,
    token: session.token,
    expires_at: session.expires_at,
    tenants: tenants.map(toPlatformTenant)
  };
}

export async function getMySubscription(token: string) {
  const user = await resolvePlatformSession(token);
  const subscription = await ensureUserSubscription(user.id);

  return {
    subscription
  };
}

export async function subscribeToPlan(input: {
  token: string;
  plan: "starter" | "growth";
}) {
  const user = await resolvePlatformSession(input.token);
  const subscription = await updateSubscriptionPlan(user.id, input.plan);

  return {
    subscription
  };
}

export async function enforcePlanLimits(userId: string, action: "create_tenant") {
  const subscription = await ensureUserSubscription(userId);

  if (subscription.status !== "active") {
    if (subscription.plan === "trial" && subscription.status === "expired") {
      throw new HttpError(403, "Your 14-day trial has expired. Choose Starter or Growth to create another workspace.");
    }

    throw new HttpError(
      403,
      `Your ${formatSubscriptionPlan(subscription.plan)} plan is not active. Update your subscription to continue.`
    );
  }

  if (action === "create_tenant" && subscription.max_tenants < 999) {
    const tenants = await listUserTenants(userId);
    if (tenants.length >= subscription.max_tenants) {
      const workspaceLabel = subscription.max_tenants === 1 ? "workspace" : "workspaces";
      throw new HttpError(
        403,
        `${formatSubscriptionPlan(subscription.plan)} allows ${subscription.max_tenants} ${workspaceLabel}. Upgrade your plan to create another workspace.`
      );
    }
  }

  return subscription;
}

export async function getPlatformProfile(token: string) {
  const user = await resolvePlatformSession(token);
  const tenants = await listUserTenants(user.id);
  const subscription = await ensureUserSubscription(user.id);

  return {
    user,
    tenants: tenants.map(toPlatformTenant),
    subscription
  };
}

export async function verifyTenantDomain(input: {
  token: string;
  tenant_id: string;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  const verification = await getDomainVerification(input.tenant_id);
  if (!verification) {
    throw new HttpError(404, "Domain verification record not found");
  }

  const dns = await verifyDnsTxtRecord({
    txtName: verification.txt_name,
    expectedValue: verification.txt_value
  });

  const current = await updateDomainVerificationStatus({
    tenantId: input.tenant_id,
    status: dns.status,
    records: dns.records,
    errorMessage: dns.error ?? null
  });

  return {
    tenant_id: input.tenant_id,
    verified: dns.status === "verified",
    records: dns.records,
    message: buildDnsStatusMessage(current.status),
    domain_verification: {
      status: current.status,
      txt_name: current.txt_name,
      txt_value: current.txt_value,
      last_checked_at: current.last_checked_at,
      last_error: current.last_error,
      last_seen_records: current.last_seen_records,
      verified_at: current.verified_at
    }
  };
}

export async function runTenantIngestion(input: {
  token: string;
  tenant_id: string;
  replace?: boolean;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  const sources = await listTenantSources(input.tenant_id);
  if (sources.length === 0) {
    throw new HttpError(400, "No tenant sources found. Add sitemap, URLs, FAQ or docs first.");
  }

  await updateTenantKnowledgeState(input.tenant_id, {
    status: "processing",
    message: "Refreshing the knowledge base from your latest saved sources.",
    last_ingested_at: null
  });

  let ingestion;
  try {
    ingestion = await ingestKnowledgeForTenant({
      tenant_id: input.tenant_id,
      sources: sources.map((source) => ({
        source_type: source.source_type,
        source_value: source.source_value
      })),
      replace: Boolean(input.replace),
      max_sitemap_urls: 40,
      max_chunks: 700
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const knowledge = await updateTenantKnowledgeState(input.tenant_id, {
      status: "error",
      message,
      last_ingested_at: null
    });

    return {
      tenant_id: input.tenant_id,
      ingestion: {
        tenant_id: input.tenant_id,
        inserted_chunks: 0,
        fetched_documents: 0,
        skipped_documents: 0,
        errors: [message]
      },
      knowledge_base: knowledge
    };
  }

  const summary = summarizeIngestion(ingestion);
  const knowledge = await updateTenantKnowledgeState(input.tenant_id, {
    status: summary.status,
    message: summary.message,
    last_ingested_at: new Date().toISOString()
  });

  return {
    tenant_id: input.tenant_id,
    ingestion,
    knowledge_base: knowledge
  };
}

export async function getTenantSourcesForUser(input: {
  token: string;
  tenant_id: string;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);
  const sources = await listTenantSources(input.tenant_id);

  return {
    tenant_id: input.tenant_id,
    sources
  };
}

export async function replaceTenantSourcesForUser(input: {
  token: string;
  tenant_id: string;
  sources: Array<{ source_type: "sitemap" | "url" | "faq" | "doc_text"; source_value: string }>;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  await replaceTenantSources(input.tenant_id, input.sources);
  const normalizedSources = input.sources.map((source) => ({
    source_type: source.source_type,
    source_value: source.source_value
  })) as TenantSourceInput[];

  const ingestion = await runProvisioningIngest({
    tenantId: input.tenant_id,
    sources: normalizedSources,
    shouldAutoIngest: shouldAutoIngestOnSourceUpdate(),
    processingMessage:
      "Updating your knowledge base from sitemap URLs, child sitemaps, docs, support pages, and pasted policies.",
    pendingMessage: "Sources saved. Start indexing to refresh the chatbot knowledge base with the latest content."
  });

  const tenant = await getOwnedTenantSummary(user.id, input.tenant_id);
  const sources = await listTenantSources(input.tenant_id);

  return {
    tenant_id: input.tenant_id,
    sources,
    knowledge_base: tenant.knowledge_base,
    ingestion
  };
}

export async function deletePlatformWorkspace(input: {
  token: string;
  tenant_id: string;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);
  await deleteTenantById(input.tenant_id);
  return { tenant_id: input.tenant_id, deleted: true };
}

export async function updatePlatformUserProfile(input: {
  token: string;
  full_name?: string;
  email?: string;
  current_password?: string;
  new_password?: string;
  avatar_url?: string | null;
}) {
  const user = await resolvePlatformSession(input.token);

  if (input.new_password) {
    if (user.has_password && !input.current_password) {
      throw new HttpError(400, "Current password is required to set a new password");
    }
    if (user.has_password && input.current_password) {
      await validatePlatformCredentials({ email: user.email, password: input.current_password });
    }
  }

  const updated = await updatePlatformUser(user.id, {
    full_name: input.full_name,
    email: input.email,
    password: input.new_password,
    avatar_url: input.avatar_url
  });

  return { user: updated };
}
