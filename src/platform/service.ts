import { randomBytes } from "crypto";
import { HttpError } from "@/lib/httpError";
import { ingestKnowledgeForTenant, type TenantSourceInput } from "@/rag/ingest";
import {
  assertTenantOwnership,
  createPlatformSession,
  createPlatformUser,
  createTenantForUser,
  deletePlatformUserById,
  findTenantIdByDomain,
  getDomainVerification,
  listTenantSources,
  listUserTenants,
  markDomainVerified,
  replaceTenantSources,
  resolvePlatformSession,
  type SupportedService,
  type TenantBusinessProfile,
  updateTenantAllowedDomain,
  updateTenantBusinessProfile,
  upsertDomainVerification,
  validatePlatformCredentials
} from "@/platform/repository";
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
  const verification = await upsertDomainVerification({
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

  const ingest = await ingestKnowledgeForTenant({
    tenant_id: tenant.tenant_id,
    sources,
    replace: true,
    max_sitemap_urls: 40,
    max_chunks: 700
  }).catch((error) => ({
    tenant_id: tenant.tenant_id,
    inserted_chunks: 0,
    fetched_documents: 0,
    skipped_documents: 0,
    errors: [error instanceof Error ? error.message : String(error)]
  }));

  const session = await createPlatformSession(user.id);
  const widget = buildWidgetConfig(tenant.tenant_id);

  return {
    user,
    token: session.token,
    expires_at: session.expires_at,
    tenant: {
      tenant_id: tenant.tenant_id,
      name: tenant.name,
      domain,
      business_profile: tenant.business_profile
    },
    domain_verification: {
      status: verification.status,
      txt_name: verification.txt_name,
      txt_value: verification.txt_value,
      verified_at: verification.verified_at
    },
    widget,
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
  const verification = await upsertDomainVerification({
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

  const ingest = await ingestKnowledgeForTenant({
    tenant_id: tenant.tenant_id,
    sources,
    replace: true,
    max_sitemap_urls: 40,
    max_chunks: 700
  }).catch((error) => ({
    tenant_id: tenant.tenant_id,
    inserted_chunks: 0,
    fetched_documents: 0,
    skipped_documents: 0,
    errors: [error instanceof Error ? error.message : String(error)]
  }));

  return {
    tenant: {
      tenant_id: tenant.tenant_id,
      name: tenant.name,
      domain,
      business_profile: tenant.business_profile
    },
    domain_verification: {
      status: verification.status,
      txt_name: verification.txt_name,
      txt_value: verification.txt_value,
      verified_at: verification.verified_at
    },
    widget: buildWidgetConfig(tenant.tenant_id),
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
  business_description?: string;
}) {
  const user = await resolvePlatformSession(input.token);
  await assertTenantOwnership(user.id, input.tenant_id);

  const profile = await updateTenantBusinessProfile(input.tenant_id, {
    business_type: input.business_type,
    supported_services: input.supported_services,
    support_phone: input.support_phone,
    support_email: input.support_email,
    support_cta_label: input.support_cta_label,
    business_description: input.business_description
  } satisfies Partial<TenantBusinessProfile>);

  return {
    tenant_id: input.tenant_id,
    business_profile: profile
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

  const tenant = await updateTenantAllowedDomain({
    tenantId: input.tenant_id,
    domain
  });

  const verificationPayload = buildDomainVerificationPayload(domain);
  const verification = await upsertDomainVerification({
    tenantId: input.tenant_id,
    domain,
    txtName: verificationPayload.txt_name,
    txtValue: verificationPayload.txt_value
  });

  return {
    tenant_id: input.tenant_id,
    domain: tenant.domain,
    allowed_domains: tenant.allowed_domains,
    domain_verification: {
      status: verification.status,
      txt_name: verification.txt_name,
      txt_value: verification.txt_value,
      verified_at: verification.verified_at
    },
    widget: buildWidgetConfig(input.tenant_id)
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
    tenants: tenants.map((tenant) => ({
      ...tenant,
      widget: buildWidgetConfig(tenant.tenant_id)
    }))
  };
}

export async function getPlatformProfile(token: string) {
  const user = await resolvePlatformSession(token);
  const tenants = await listUserTenants(user.id);

  return {
    user,
    tenants: tenants.map((tenant) => ({
      ...tenant,
      widget: buildWidgetConfig(tenant.tenant_id)
    }))
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

  if (dns.verified && verification.status !== "verified") {
    await markDomainVerified(input.tenant_id);
  }

  const current = await getDomainVerification(input.tenant_id);
  return {
    tenant_id: input.tenant_id,
    verified: dns.verified,
    records: dns.records,
    domain_verification: current
      ? {
          status: current.status,
          txt_name: current.txt_name,
          txt_value: current.txt_value,
          verified_at: current.verified_at
        }
      : null
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

  const ingestion = await ingestKnowledgeForTenant({
    tenant_id: input.tenant_id,
    sources: sources.map((source) => ({
      source_type: source.source_type,
      source_value: source.source_value
    })),
    replace: Boolean(input.replace),
    max_sitemap_urls: 40,
    max_chunks: 700
  });

  return {
    tenant_id: input.tenant_id,
    ingestion
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
  const sources = await listTenantSources(input.tenant_id);

  return {
    tenant_id: input.tenant_id,
    sources
  };
}
