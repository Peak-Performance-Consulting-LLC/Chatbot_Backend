import { z } from "zod";

const urlSchema = z.string().trim().url().max(1000);
const optionalUrlSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  urlSchema.optional()
);
const clearableOptionalUrlSchema = z.preprocess(
  (value) => {
    if (value === null) {
      return null;
    }
    if (typeof value === "string" && value.trim() === "") {
      return null;
    }
    return value;
  },
  urlSchema.nullable().optional()
);
const colorSchema = z.string().trim().regex(
  /^(#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+))?\s*\))$/,
  "Use a valid hex or rgba color"
);

export const supportedServiceSchema = z.enum(["flights", "hotels", "cars", "cruises"]);
export const widgetPositionSchema = z.enum(["left", "right"]);
export const launcherStyleSchema = z.enum(["rounded", "pill", "square", "minimal"]);
export const themeStyleSchema = z.enum(["standard", "glass", "clay", "dark", "minimal"]);
export const bgPatternSchema = z.enum(["none", "dots", "grid", "waves"]);
export const launcherIconSchema = z.enum(["chat", "sparkle", "headset", "zap", "heart"]);
export const aiToneSchema = z.enum(["friendly", "professional", "concise", "enthusiastic"]);
export const notifAnimationSchema = z.enum(["bounce", "pulse", "slide"]);

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

export const platformForgotPasswordSchema = z.object({
  email: z.string().trim().email().max(160)
});

export const platformResetPasswordSchema = z.object({
  token: z.string().trim().min(32).max(512),
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
  header_cta_label: z.string().trim().max(40).optional(),
  header_cta_notice: z.string().trim().min(8).max(180).optional(),
  business_description: z.string().trim().max(1000).optional(),
  primary_color: colorSchema.optional(),
  user_bubble_color: colorSchema.optional(),
  bot_bubble_color: colorSchema.optional(),
  font_family: z.string().trim().min(2).max(80).optional(),
  widget_position: widgetPositionSchema.optional(),
  launcher_style: launcherStyleSchema.optional(),
  theme_style: themeStyleSchema.optional(),
  bg_pattern: bgPatternSchema.optional(),
  launcher_icon: launcherIconSchema.optional(),
  window_width: z.number().int().min(320).max(520).optional(),
  window_height: z.number().int().min(520).max(860).optional(),
  border_radius: z.number().int().min(8).max(36).optional(),
  welcome_message: z.string().trim().min(8).max(320).optional(),
  bot_name: z.string().trim().min(2).max(80).optional(),
  bot_avatar_url: optionalUrlSchema,
  quick_replies: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
  ai_tone: aiToneSchema.optional(),
  notif_enabled: z.boolean().optional(),
  notif_text: z.string().trim().min(1).max(60).optional(),
  notif_animation: notifAnimationSchema.optional(),
  notif_chips: z.array(z.string().trim().min(1).max(40)).max(4).optional()
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

export const platformDeleteWorkspaceSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80)
});

export const platformUpdateUserSchema = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(160).optional(),
  current_password: z.string().min(8).max(120).optional(),
  new_password: z.string().min(8).max(120).optional(),
  avatar_url: clearableOptionalUrlSchema
});

export const platformSubscribeSchema = z.object({
  plan: z.enum(["starter", "growth"])
});

export const platformAnalyticsRangeSchema = z.enum(["7d", "30d", "billing_cycle"]);

export const platformAnalyticsQuerySchema = z.object({
  range: platformAnalyticsRangeSchema.optional().default("7d"),
  tenant_id: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(2).max(80).optional()
  ),
  timezone: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(120).optional()
  )
});
