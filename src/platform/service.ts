import { randomBytes } from "crypto";
import type Stripe from "stripe";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { ingestKnowledgeForTenant, type TenantSourceInput } from "@/rag/ingest";
import { clearRetrievalCache } from "@/rag/retrieve";
import { createPasswordResetToken, hashOpaqueToken } from "@/platform/auth";
import { sendPlatformPasswordResetEmail } from "@/platform/email";
import { enforcePlatformPasswordResetRateLimit } from "@/platform/passwordResetRateLimit";
import {
  assertTenantOwnership,
  consumePlatformPasswordReset,
  createPlatformSession,
  createPlatformPasswordResetToken,
  createTrialSubscription,
  createPlatformUser,
  createTenantForUser,
  deletePlatformUserById,
  deleteTenantById,
  findTenantIdByDomain,
  getDomainVerification,
  getPlatformUserByEmail,
  getSubscriptionByStripeSubscriptionId,
  getSubscriptionByUserId,
  getPlatformUsageTrackingStartedAt,
  listTenantSources,
  listPlatformAnalyticsMessages,
  listPlatformUsageEvents,
  listTenantVisitorContacts,
  listUserTenants,
  replaceTenantSources,
  resolvePlatformSession,
  syncSubscriptionFromStripe,
  type PlatformAnalyticsMessageRow,
  type PlatformAnalyticsUsageRow,
  type PlatformVisitorContactRow,
  type SubscriptionSummary,
  type SupportedService,
  type TenantBusinessProfile,
  type TenantSummary,
  updateDomainVerificationStatus,
  updateSubscriptionStatusByStripeSubscriptionId,
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
import {
  buildPlatformCheckoutUrls,
  getStripeClient,
  getStripePriceId,
  isPaidPlan,
  normalizeStripeMetadataValue,
  toIsoFromStripeTimestamp
} from "@/platform/stripe";
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

function buildPasswordResetUrl(token: string): string {
  const appUrl = new URL(getEnv().PLATFORM_APP_URL);
  const resetUrl = new URL("/platform/reset-password", appUrl);
  resetUrl.searchParams.set("token", token);
  return resetUrl.toString();
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
    clearRetrievalCache(input.tenantId);

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
  clearRetrievalCache(input.tenantId);

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

export async function requestPlatformPasswordReset(input: {
  email: string;
  ipAddress?: string | null;
}) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const ipAddress = input.ipAddress?.trim() || "unknown";

  enforcePlatformPasswordResetRateLimit(`platform-password-reset:request:${ipAddress}:${normalizedEmail}`);

  const user = await getPlatformUserByEmail(normalizedEmail);
  const message =
    "If that email exists, a password reset link has been sent.";

  if (!user) {
    return {
      ok: true,
      message
    };
  }

  const env = getEnv();
  const { token, tokenHash } = createPasswordResetToken();
  const expiresAt = new Date(
    Date.now() + env.PLATFORM_PASSWORD_RESET_TTL_MINUTES * 60 * 1000
  ).toISOString();

  await createPlatformPasswordResetToken({
    userId: user.id,
    tokenHash,
    expiresAt
  });

  await sendPlatformPasswordResetEmail({
    to: user.email,
    fullName: user.full_name,
    resetUrl: buildPasswordResetUrl(token),
    expiresInMinutes: env.PLATFORM_PASSWORD_RESET_TTL_MINUTES
  });

  return {
    ok: true,
    message
  };
}

export async function resetPlatformPassword(input: {
  token: string;
  password: string;
  ipAddress?: string | null;
}) {
  const ipAddress = input.ipAddress?.trim() || "unknown";
  enforcePlatformPasswordResetRateLimit(`platform-password-reset:submit:${ipAddress}`);

  await consumePlatformPasswordReset({
    tokenHash: hashOpaqueToken(input.token.trim()),
    password: input.password
  });

  return {
    ok: true,
    message: "Password updated. You can now sign in with your new password."
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

export async function createSubscriptionCheckout(input: {
  token: string;
  plan: "starter" | "growth";
}) {
  const user = await resolvePlatformSession(input.token);
  const subscription = await ensureUserSubscription(user.id);
  const stripe = getStripeClient();

  if (
    subscription.plan === input.plan &&
    subscription.status === "active" &&
    subscription.stripe_subscription_id &&
    !subscription.cancel_at_period_end
  ) {
    throw new HttpError(400, `Your ${formatSubscriptionPlan(input.plan)} plan is already active.`);
  }

  const previousSubscriptionId =
    subscription.stripe_subscription_id && isPaidPlan(subscription.plan)
      ? subscription.stripe_subscription_id
      : null;
  const urls = buildPlatformCheckoutUrls(input.plan);
  const metadata = {
    user_id: user.id,
    plan: input.plan,
    previous_subscription_id: previousSubscriptionId ?? ""
  };

  const priceId = getStripePriceId(input.plan);
  const envKey = input.plan === "starter" ? "STRIPE_PRICE_STARTER" : "STRIPE_PRICE_GROWTH";

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: user.id,
      success_url: urls.success_url,
      cancel_url: urls.cancel_url,
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      metadata,
      subscription_data: {
        metadata
      },
      ...(subscription.stripe_customer_id
        ? { customer: subscription.stripe_customer_id }
        : { customer_email: user.email })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe Checkout session creation failed";
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;

    if (code === "resource_missing" && message.includes(`No such price: '${priceId}'`)) {
      throw new HttpError(
        500,
        `${envKey} is set to ${priceId}, but Stripe cannot find that price for the active STRIPE_SECRET_KEY. If this request is hitting a deployed backend, update the backend environment variables so STRIPE_SECRET_KEY and ${envKey} come from the same Stripe account, then redeploy.`
      );
    }

    throw error;
  }

  if (!session.url) {
    throw new HttpError(500, "Stripe Checkout session did not return a hosted URL");
  }

  return {
    checkout_url: session.url,
    session_id: session.id
  };
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice) {
  const parentSubscription = invoice.parent?.subscription_details?.subscription;
  if (typeof parentSubscription === "string") {
    return parentSubscription;
  }

  return parentSubscription?.id ?? null;
}

function getStripeSubscriptionPeriod(subscription: Stripe.Subscription) {
  const firstItem = subscription.items.data[0];
  return {
    current_period_start: toIsoFromStripeTimestamp(firstItem?.current_period_start ?? subscription.created),
    current_period_end: toIsoFromStripeTimestamp(
      firstItem?.current_period_end ?? subscription.cancel_at ?? subscription.created
    )
  };
}

async function schedulePreviousStripeSubscriptionForCancellation(stripeSubscriptionId: string) {
  const stripe = getStripeClient();
  const previousSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  if (previousSubscription.status === "canceled" || previousSubscription.cancel_at_period_end) {
    return;
  }

  await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: true
  });
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) {
    return { handled: false, reason: "missing_subscription_id" as const };
  }

  const stripe = getStripeClient();
  const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const userId = normalizeStripeMetadataValue(stripeSubscription.metadata.user_id);
  const plan = normalizeStripeMetadataValue(stripeSubscription.metadata.plan);
  const previousSubscriptionId = normalizeStripeMetadataValue(
    stripeSubscription.metadata.previous_subscription_id
  );

  if (!userId || !plan || !isPaidPlan(plan)) {
    return { handled: false, reason: "missing_metadata" as const };
  }

  const currentLocalSubscription = await getSubscriptionByUserId(userId);
  if (
    currentLocalSubscription?.stripe_subscription_id &&
    currentLocalSubscription.stripe_subscription_id !== stripeSubscription.id &&
    previousSubscriptionId !== currentLocalSubscription.stripe_subscription_id
  ) {
    return { handled: false, reason: "obsolete_subscription" as const };
  }

  if (previousSubscriptionId && previousSubscriptionId !== stripeSubscription.id) {
    await schedulePreviousStripeSubscriptionForCancellation(previousSubscriptionId);
  }

  const subscriptionPeriod = getStripeSubscriptionPeriod(stripeSubscription);

  await syncSubscriptionFromStripe({
    user_id: userId,
    plan,
    stripe_customer_id:
      typeof stripeSubscription.customer === "string"
        ? stripeSubscription.customer
        : stripeSubscription.customer?.id ?? null,
    stripe_subscription_id: stripeSubscription.id,
    stripe_price_id: stripeSubscription.items.data[0]?.price.id ?? null,
    stripe_status: stripeSubscription.status,
    cancel_at_period_end: Boolean(stripeSubscription.cancel_at_period_end),
    current_period_start: subscriptionPeriod.current_period_start,
    current_period_end: subscriptionPeriod.current_period_end
  });

  return { handled: true as const };
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) {
    return { handled: false, reason: "missing_subscription_id" as const };
  }

  const localSubscription = await getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
  if (!localSubscription) {
    return { handled: false, reason: "unknown_subscription" as const };
  }

  await updateSubscriptionStatusByStripeSubscriptionId({
    stripe_subscription_id: stripeSubscriptionId,
    status: "past_due"
  });

  return { handled: true as const };
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const localSubscription = await getSubscriptionByStripeSubscriptionId(subscription.id);
  if (!localSubscription) {
    return { handled: false, reason: "unknown_subscription" as const };
  }
  const subscriptionPeriod = getStripeSubscriptionPeriod(subscription);

  await updateSubscriptionStatusByStripeSubscriptionId({
    stripe_subscription_id: subscription.id,
    status: "canceled",
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    current_period_start: subscriptionPeriod.current_period_start,
    current_period_end: subscriptionPeriod.current_period_end
  });

  return { handled: true as const };
}

export async function handleStripeWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case "invoice.paid":
      return handleInvoicePaid(event.data.object as Stripe.Invoice);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
    default:
      return { handled: false, reason: "ignored_event_type" as const };
  }
}

export type PlatformAnalyticsRange = "7d" | "30d" | "billing_cycle";

export type PlatformAnalyticsSummary = {
  conversations: number;
  messages_total: number;
  user_messages: number;
  assistant_messages: number;
  unique_visitors: number;
  tokens_total: number;
  tokens_exact: number;
  tokens_estimated: number;
  avg_response_ms: number | null;
  message_quota_used: number;
  message_quota_limit: number;
};

export type PlatformAnalyticsPoint = {
  bucket_start: string;
  conversations: number;
  messages_total: number;
  unique_visitors: number;
  tokens_total: number;
};

export type PlatformAnalyticsWorkspaceRow = {
  tenant_id: string;
  name: string;
  messages_total: number;
  tokens_total: number;
  conversations: number;
  unique_visitors: number;
};

export type PlatformAnalyticsBreakdownRow = {
  key: string;
  label: string;
  value: number;
  share: number;
};

export type PlatformAnalyticsTokenSourceRow = {
  key: "provider" | "counted" | "estimated" | "none";
  label: string;
  value: number;
  share: number;
};

export type PlatformAnalyticsHealth = {
  workspaces_total: number;
  dns_verified_count: number;
  knowledge_ready_count: number;
  widget_ready_count: number;
};

export type PlatformAnalyticsScope = {
  summary: PlatformAnalyticsSummary;
  trend: PlatformAnalyticsPoint[];
  services: PlatformAnalyticsBreakdownRow[];
  intents: PlatformAnalyticsBreakdownRow[];
  token_sources: PlatformAnalyticsTokenSourceRow[];
  knowledge_hit_rate: number | null;
  avg_response_ms: number | null;
};

export type PlatformAnalyticsResponse = {
  range: PlatformAnalyticsRange;
  timezone: string;
  generated_at: string;
  token_tracking_started_at: string | null;
  account: PlatformAnalyticsScope & {
    workspaces: PlatformAnalyticsWorkspaceRow[];
    health: PlatformAnalyticsHealth;
  };
  workspace:
    | (PlatformAnalyticsScope & {
        tenant_id: string;
        name: string;
      })
    | null;
};

export type PlatformVisitorContact = {
  id: string;
  tenant_id: string;
  device_id: string;
  chat_id: string | null;
  full_name: string;
  email: string;
  phone: string;
  captured_at: string;
};

export type PlatformVisitorContactsResponse = {
  tenant_id: string;
  total: number;
  limit: number;
  offset: number;
  contacts: PlatformVisitorContact[];
};

const ANALYTICS_CACHE_TTL_MS = 60_000;
const ANALYTICS_QUERY_PADDING_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const analyticsCache = new Map<
  string,
  {
    expiresAt: number;
    value: PlatformAnalyticsResponse;
  }
>();

function getDateFormatter(timezone: string) {
  const cached = dateFormatterCache.get(timezone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  dateFormatterCache.set(timezone, formatter);
  return formatter;
}

function normalizeAnalyticsTimezone(input?: string) {
  const value = input?.trim();
  if (!value) {
    return "UTC";
  }

  try {
    getDateFormatter(value).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function toDateKey(input: string | Date, timezone: string) {
  const date = input instanceof Date ? input : new Date(input);
  const parts = getDateFormatter(timezone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDateKeyRange(startKey: string, endKey: string) {
  const keys: string[] = [];
  let cursor = startKey;
  while (cursor <= endKey) {
    keys.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
  }
  return keys;
}

function formatLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildBreakdownRows(
  counts: Map<string, number>,
  labelBuilder: (key: string) => string
): PlatformAnalyticsBreakdownRow[] {
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(counts.entries())
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => ({
      key,
      label: labelBuilder(key),
      value,
      share: total > 0 ? value / total : 0
    }));
}

function buildTokenSourceRows(
  counts: Map<"provider" | "counted" | "estimated" | "none", number>
): PlatformAnalyticsTokenSourceRow[] {
  const orderedKeys: Array<"provider" | "counted" | "estimated" | "none"> = [
    "provider",
    "counted",
    "estimated",
    "none"
  ];
  const total = orderedKeys.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);

  return orderedKeys.map((key) => ({
    key,
    label: formatLabel(key),
    value: counts.get(key) ?? 0,
    share: total > 0 ? (counts.get(key) ?? 0) / total : 0
  }));
}

function filterMessagesByDateRange(
  rows: PlatformAnalyticsMessageRow[],
  timezone: string,
  startKey: string,
  endKey: string
) {
  return rows.filter((row) => {
    const dateKey = toDateKey(row.created_at, timezone);
    return dateKey >= startKey && dateKey <= endKey;
  });
}

function filterUsageEventsByDateRange(
  rows: PlatformAnalyticsUsageRow[],
  timezone: string,
  startKey: string,
  endKey: string
) {
  return rows.filter((row) => {
    const dateKey = toDateKey(row.created_at, timezone);
    return dateKey >= startKey && dateKey <= endKey;
  });
}

function buildWorkspaceRows(input: {
  tenantMap: Map<string, TenantSummary>;
  messages: PlatformAnalyticsMessageRow[];
  usageEvents: PlatformAnalyticsUsageRow[];
}): PlatformAnalyticsWorkspaceRow[] {
  const usageByTenant = new Map<
    string,
    {
      messages_total: number;
      tokens_total: number;
      conversations: Set<string>;
      unique_visitors: Set<string>;
    }
  >();

  for (const row of input.messages) {
    let summary = usageByTenant.get(row.tenant_id);
    if (!summary) {
      summary = {
        messages_total: 0,
        tokens_total: 0,
        conversations: new Set<string>(),
        unique_visitors: new Set<string>()
      };
      usageByTenant.set(row.tenant_id, summary);
    }

    summary.messages_total += 1;
    if (row.role === "user") {
      summary.conversations.add(row.chat_id);
      summary.unique_visitors.add(row.device_id);
    }
  }

  for (const row of input.usageEvents) {
    let summary = usageByTenant.get(row.tenant_id);
    if (!summary) {
      summary = {
        messages_total: 0,
        tokens_total: 0,
        conversations: new Set<string>(),
        unique_visitors: new Set<string>()
      };
      usageByTenant.set(row.tenant_id, summary);
    }

    summary.tokens_total += row.total_tokens ?? 0;
  }

  return Array.from(usageByTenant.entries())
    .map(([tenantId, summary]) => {
      const tenant = input.tenantMap.get(tenantId);
      return {
        tenant_id: tenantId,
        name: tenant?.name?.trim() || tenant?.business_profile.bot_name || tenantId,
        messages_total: summary.messages_total,
        tokens_total: summary.tokens_total,
        conversations: summary.conversations.size,
        unique_visitors: summary.unique_visitors.size
      };
    })
    .filter((row) => row.messages_total > 0 || row.tokens_total > 0)
    .sort(
      (left, right) =>
        right.messages_total - left.messages_total ||
        right.tokens_total - left.tokens_total ||
        left.name.localeCompare(right.name)
    );
}

function buildHealthSummary(tenants: TenantSummary[]): PlatformAnalyticsHealth {
  const dnsVerifiedCount = tenants.filter(
    (tenant) => tenant.domain_verification?.status === "verified"
  ).length;
  const knowledgeReadyCount = tenants.filter(
    (tenant) =>
      tenant.knowledge_base.status === "ready" || tenant.knowledge_base.status === "warning"
  ).length;

  return {
    workspaces_total: tenants.length,
    dns_verified_count: dnsVerifiedCount,
    knowledge_ready_count: knowledgeReadyCount,
    widget_ready_count: dnsVerifiedCount
  };
}

function aggregateAnalyticsScope(input: {
  messages: PlatformAnalyticsMessageRow[];
  usageEvents: PlatformAnalyticsUsageRow[];
  bucketKeys: string[];
  timezone: string;
  messageQuotaUsed: number;
  messageQuotaLimit: number;
}): PlatformAnalyticsScope {
  const bucketMap = new Map<
    string,
    {
      conversations: Set<string>;
      uniqueVisitors: Set<string>;
      messages_total: number;
      tokens_total: number;
    }
  >();

  for (const bucketKey of input.bucketKeys) {
    bucketMap.set(bucketKey, {
      conversations: new Set<string>(),
      uniqueVisitors: new Set<string>(),
      messages_total: 0,
      tokens_total: 0
    });
  }

  let userMessages = 0;
  let assistantMessages = 0;
  const conversations = new Set<string>();
  const uniqueVisitors = new Set<string>();

  for (const row of input.messages) {
    const bucket = bucketMap.get(toDateKey(row.created_at, input.timezone));
    if (!bucket) {
      continue;
    }

    bucket.messages_total += 1;
    if (row.role === "user") {
      userMessages += 1;
      conversations.add(row.chat_id);
      uniqueVisitors.add(row.device_id);
      bucket.conversations.add(row.chat_id);
      bucket.uniqueVisitors.add(row.device_id);
    } else if (row.role === "assistant") {
      assistantMessages += 1;
    }
  }

  let tokensTotal = 0;
  let tokensExact = 0;
  let tokensEstimated = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const serviceCounts = new Map<string, number>();
  const intentCounts = new Map<string, number>();
  const tokenSourceCounts = new Map<"provider" | "counted" | "estimated" | "none", number>([
    ["provider", 0],
    ["counted", 0],
    ["estimated", 0],
    ["none", 0]
  ]);
  let knowledgeTotal = 0;
  let knowledgeHits = 0;

  for (const row of input.usageEvents) {
    const totalTokens = row.total_tokens ?? 0;
    tokensTotal += totalTokens;

    if (row.token_source === "provider" || row.token_source === "counted") {
      tokensExact += totalTokens;
    } else if (row.token_source === "estimated") {
      tokensEstimated += totalTokens;
    }

    tokenSourceCounts.set(row.token_source, (tokenSourceCounts.get(row.token_source) ?? 0) + totalTokens);

    const bucket = bucketMap.get(toDateKey(row.created_at, input.timezone));
    if (bucket) {
      bucket.tokens_total += totalTokens;
    }

    if (typeof row.latency_ms === "number" && Number.isFinite(row.latency_ms)) {
      latencySum += row.latency_ms;
      latencyCount += 1;
    }

    const serviceKey = row.service?.trim() || "general";
    serviceCounts.set(serviceKey, (serviceCounts.get(serviceKey) ?? 0) + 1);
    intentCounts.set(row.intent, (intentCounts.get(row.intent) ?? 0) + 1);

    if (row.intent === "knowledge" && row.rag_match !== null) {
      knowledgeTotal += 1;
      if (row.rag_match) {
        knowledgeHits += 1;
      }
    }
  }

  const avgResponseMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;
  const trend = input.bucketKeys.map((bucketKey) => {
    const bucket = bucketMap.get(bucketKey);
    return {
      bucket_start: bucketKey,
      conversations: bucket?.conversations.size ?? 0,
      messages_total: bucket?.messages_total ?? 0,
      unique_visitors: bucket?.uniqueVisitors.size ?? 0,
      tokens_total: bucket?.tokens_total ?? 0
    };
  });

  return {
    summary: {
      conversations: conversations.size,
      messages_total: input.messages.length,
      user_messages: userMessages,
      assistant_messages: assistantMessages,
      unique_visitors: uniqueVisitors.size,
      tokens_total: tokensTotal,
      tokens_exact: tokensExact,
      tokens_estimated: tokensEstimated,
      avg_response_ms: avgResponseMs,
      message_quota_used: input.messageQuotaUsed,
      message_quota_limit: input.messageQuotaLimit
    },
    trend,
    services: buildBreakdownRows(serviceCounts, (key) => formatLabel(key)),
    intents: buildBreakdownRows(intentCounts, (key) => formatLabel(key)),
    token_sources: buildTokenSourceRows(tokenSourceCounts),
    knowledge_hit_rate: knowledgeTotal > 0 ? knowledgeHits / knowledgeTotal : null,
    avg_response_ms: avgResponseMs
  };
}

function getCachedAnalytics(key: string) {
  const cached = analyticsCache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    analyticsCache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedAnalytics(key: string, value: PlatformAnalyticsResponse) {
  analyticsCache.set(key, {
    expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS,
    value
  });
}

function getAnalyticsDateRange(
  range: PlatformAnalyticsRange,
  subscription: SubscriptionSummary,
  timezone: string
) {
  const now = new Date();
  const endAt = now.toISOString();
  const endKey = toDateKey(now, timezone);

  if (range === "billing_cycle") {
    const currentPeriodStart = new Date(subscription.current_period_start);
    const startKey = toDateKey(currentPeriodStart, timezone);
    return {
      queryStartAt: new Date(currentPeriodStart.getTime() - ANALYTICS_QUERY_PADDING_MS).toISOString(),
      endAt,
      startKey,
      endKey,
      bucketKeys: buildDateKeyRange(startKey, endKey)
    };
  }

  const lookbackDays = range === "30d" ? 29 : 6;
  const paddedStart = new Date(now.getTime() - (lookbackDays + 2) * DAY_MS);
  const startKey = toDateKey(new Date(now.getTime() - lookbackDays * DAY_MS), timezone);

  return {
    queryStartAt: paddedStart.toISOString(),
    endAt,
    startKey,
    endKey,
    bucketKeys: buildDateKeyRange(startKey, endKey)
  };
}

function toPlatformVisitorContact(row: PlatformVisitorContactRow): PlatformVisitorContact {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    chat_id: row.chat_id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone_raw || row.phone_normalized,
    captured_at: row.captured_at
  };
}

export async function getPlatformAnalytics(input: {
  token: string;
  range: PlatformAnalyticsRange;
  tenant_id?: string;
  timezone?: string;
}): Promise<PlatformAnalyticsResponse> {
  const user = await resolvePlatformSession(input.token);
  const timezone = normalizeAnalyticsTimezone(input.timezone);
  const cacheKey = `${user.id}:${input.tenant_id ?? "all"}:${input.range}:${timezone}`;
  const cached = getCachedAnalytics(cacheKey);
  if (cached) {
    return cached;
  }

  const [subscription, tenants] = await Promise.all([
    ensureUserSubscription(user.id),
    listUserTenants(user.id)
  ]);
  const tenantMap = new Map(tenants.map((tenant) => [tenant.tenant_id, tenant]));
  const selectedTenant = input.tenant_id ? tenantMap.get(input.tenant_id) ?? null : null;

  if (input.tenant_id && !selectedTenant) {
    throw new HttpError(404, "Tenant not found");
  }

  const ownedTenantIds = tenants.map((tenant) => tenant.tenant_id);
  const rangeWindow = getAnalyticsDateRange(input.range, subscription, timezone);

  const [rangeMessages, rangeUsageEvents, currentPeriodMessages, tokenTrackingStartedAt] =
    await Promise.all([
      listPlatformAnalyticsMessages({
        tenant_ids: ownedTenantIds,
        start_at: rangeWindow.queryStartAt,
        end_at: rangeWindow.endAt
      }),
      listPlatformUsageEvents({
        tenant_ids: ownedTenantIds,
        start_at: rangeWindow.queryStartAt,
        end_at: rangeWindow.endAt
      }),
      listPlatformAnalyticsMessages({
        tenant_ids: ownedTenantIds,
        start_at: subscription.current_period_start,
        end_at: rangeWindow.endAt
      }),
      getPlatformUsageTrackingStartedAt(ownedTenantIds)
    ]);
  const currentPeriodUserMessageCount = currentPeriodMessages.filter((row) => row.role === "user").length;

  const filteredRangeMessages = filterMessagesByDateRange(
    rangeMessages,
    timezone,
    rangeWindow.startKey,
    rangeWindow.endKey
  );
  const filteredRangeUsageEvents = filterUsageEventsByDateRange(
    rangeUsageEvents,
    timezone,
    rangeWindow.startKey,
    rangeWindow.endKey
  );

  const accountScope = aggregateAnalyticsScope({
    messages: filteredRangeMessages,
    usageEvents: filteredRangeUsageEvents,
    bucketKeys: rangeWindow.bucketKeys,
    timezone,
    messageQuotaUsed: currentPeriodUserMessageCount,
    messageQuotaLimit: subscription.max_messages_mo
  });

  const workspaceMessages = selectedTenant
    ? filteredRangeMessages.filter((row) => row.tenant_id === selectedTenant.tenant_id)
    : [];
  const workspaceUsageEvents = selectedTenant
    ? filteredRangeUsageEvents.filter((row) => row.tenant_id === selectedTenant.tenant_id)
    : [];
  const workspaceCurrentPeriodMessages = selectedTenant
    ? currentPeriodMessages.filter((row) => row.tenant_id === selectedTenant.tenant_id)
    : [];
  const workspaceCurrentPeriodUserMessages = workspaceCurrentPeriodMessages.filter(
    (row) => row.role === "user"
  );

  const response: PlatformAnalyticsResponse = {
    range: input.range,
    timezone,
    generated_at: new Date().toISOString(),
    token_tracking_started_at: tokenTrackingStartedAt,
    account: {
      ...accountScope,
      workspaces: buildWorkspaceRows({
        tenantMap,
        messages: filteredRangeMessages,
        usageEvents: filteredRangeUsageEvents
      }),
      health: buildHealthSummary(tenants)
    },
    workspace: selectedTenant
      ? {
          tenant_id: selectedTenant.tenant_id,
          name:
            selectedTenant.name?.trim() ||
            selectedTenant.business_profile.bot_name ||
            selectedTenant.tenant_id,
          ...aggregateAnalyticsScope({
            messages: workspaceMessages,
            usageEvents: workspaceUsageEvents,
            bucketKeys: rangeWindow.bucketKeys,
            timezone,
            messageQuotaUsed: workspaceCurrentPeriodUserMessages.length,
            messageQuotaLimit: subscription.max_messages_mo
          })
        }
      : null
  };

  setCachedAnalytics(cacheKey, response);
  return response;
}

export async function getPlatformVisitorContacts(input: {
  token: string;
  tenant_id: string;
  query?: string;
  limit: number;
  offset: number;
}): Promise<PlatformVisitorContactsResponse> {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  const { contacts, total } = await listTenantVisitorContacts({
    tenant_id: input.tenant_id,
    query: input.query,
    limit: input.limit,
    offset: input.offset
  });

  return {
    tenant_id: input.tenant_id,
    total,
    limit: input.limit,
    offset: input.offset,
    contacts: contacts.map(toPlatformVisitorContact)
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
    clearRetrievalCache(input.tenant_id);

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
  clearRetrievalCache(input.tenant_id);

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
