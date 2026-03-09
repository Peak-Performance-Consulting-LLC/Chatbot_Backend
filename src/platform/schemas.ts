import { z } from "zod";

const urlSchema = z
  .string()
  .trim()
  .url()
  .max(1000);

export const supportedServiceSchema = z.enum(["flights", "hotels", "cars", "cruises"]);

export const platformSignupSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  password: z.string().min(8).max(120),
  company_name: z.string().trim().min(2).max(120),
  website_url: urlSchema,
  sitemap_url: urlSchema.optional(),
  faq_text: z.string().trim().max(20000).optional(),
  doc_urls: z.array(urlSchema).max(30).optional(),
  business_type: z.string().trim().min(2).max(80).optional(),
  supported_services: z.array(supportedServiceSchema).min(1).max(4).optional(),
  support_phone: z.string().trim().min(7).max(40).optional(),
  support_email: z.string().trim().email().max(160).optional(),
  support_cta_label: z.string().trim().min(3).max(80).optional(),
  business_description: z.string().trim().max(1000).optional()
});

export const platformLoginSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(8).max(120)
});

export const platformVerifyDomainSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80)
});

export const platformIngestSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  replace: z.boolean().optional().default(false)
});

export const platformTenantParamSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80)
});

export const platformTenantProfileSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  business_type: z.string().trim().min(2).max(80).optional(),
  supported_services: z.array(supportedServiceSchema).min(1).max(4).optional(),
  support_phone: z.string().trim().min(7).max(40).optional(),
  support_email: z.string().trim().email().max(160).optional(),
  support_cta_label: z.string().trim().min(3).max(80).optional(),
  business_description: z.string().trim().max(1000).optional()
});

export const platformTenantDomainSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  website_url: urlSchema
});

export const platformCreateWorkspaceSchema = z.object({
  company_name: z.string().trim().min(2).max(120),
  website_url: urlSchema,
  sitemap_url: urlSchema.optional(),
  faq_text: z.string().trim().max(20000).optional(),
  doc_urls: z.array(urlSchema).max(30).optional(),
  business_type: z.string().trim().min(2).max(80).optional(),
  supported_services: z.array(supportedServiceSchema).min(1).max(4).optional(),
  support_phone: z.string().trim().min(7).max(40).optional(),
  support_email: z.string().trim().email().max(160).optional(),
  support_cta_label: z.string().trim().min(3).max(80).optional(),
  business_description: z.string().trim().max(1000).optional()
});

export const platformTenantSourcesQuerySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80)
});

export const platformTenantSourcesSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  sources: z
    .array(
      z.object({
        source_type: z.enum(["sitemap", "url", "faq", "doc_text"]),
        source_value: z.string().trim().min(1).max(20000)
      })
    )
    .max(200)
});
