import { getEnv } from "@/config/env";
import type { TenantBusinessProfile } from "@/platform/repository";

function ensureBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function escapeAttribute(value: string) {
  return value.replace(/'/g, "&#39;");
}

export function buildWidgetConfig(input: {
  tenantId: string;
  domainVerified: boolean;
  businessProfile: TenantBusinessProfile;
}) {
  const env = getEnv();
  const widgetHostUrl = ensureBaseUrl(env.WIDGET_HOST_URL);
  const backendUrl = ensureBaseUrl(env.BACKEND_PUBLIC_URL);
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

  if (isProduction && (widgetHostUrl.includes("localhost") || backendUrl.includes("localhost"))) {
    throw new Error("WIDGET_HOST_URL and BACKEND_PUBLIC_URL must be production URLs on Vercel.");
  }

  const blockedReason =
    "You can continue testing your chatbot inside the portal. To use it on your website via widget/embed, please complete DNS verification first.";

  if (!input.domainVerified) {
    return {
      tenant_id: input.tenantId,
      enabled: false,
      status: "dns_required" as const,
      blocked_reason: blockedReason,
      widget_host_url: widgetHostUrl,
      backend_url: backendUrl,
      embed_url: null,
      script_snippet: null,
      react_snippet: null
    };
  }

  const params = new URLSearchParams({
    embed: "1",
    tenant_id: input.tenantId,
    backend_url: backendUrl,
    bot_name: input.businessProfile.bot_name,
    welcome_message: input.businessProfile.welcome_message,
    primary_color: input.businessProfile.primary_color,
    user_bubble_color: input.businessProfile.user_bubble_color,
    bot_bubble_color: input.businessProfile.bot_bubble_color,
    font_family: input.businessProfile.font_family,
    widget_position: input.businessProfile.widget_position,
    launcher_style: input.businessProfile.launcher_style,
    border_radius: String(input.businessProfile.border_radius),
    support_phone: input.businessProfile.support_phone || "",
    support_cta_label: input.businessProfile.support_cta_label || "",
    avatar_url: input.businessProfile.bot_avatar_url || ""
  });

  const embedUrl = `${widgetHostUrl}/?${params.toString()}`;
  const iframeRight = input.businessProfile.widget_position === "left" ? "auto" : "16px";
  const iframeLeft = input.businessProfile.widget_position === "left" ? "16px" : "auto";

  const script = `<script>
(function () {
  var iframe = document.createElement('iframe');
  iframe.src = '${escapeAttribute(embedUrl)}';
  iframe.title = '${escapeAttribute(input.businessProfile.bot_name)} Chat';
  iframe.style.position = 'fixed';
  iframe.style.right = '${iframeRight}';
  iframe.style.left = '${iframeLeft}';
  iframe.style.bottom = '16px';
  iframe.style.width = '${input.businessProfile.window_width}px';
  iframe.style.height = '${input.businessProfile.window_height}px';
  iframe.style.maxWidth = 'calc(100vw - 24px)';
  iframe.style.maxHeight = 'calc(100vh - 24px)';
  iframe.style.border = '0';
  iframe.style.borderRadius = '${input.businessProfile.border_radius}px';
  iframe.style.overflow = 'hidden';
  iframe.style.zIndex = '2147483000';
  iframe.style.background = 'transparent';
  iframe.allow = 'clipboard-write';
  document.body.appendChild(iframe);
})();
</script>`;

  const appearance = {
    primaryColor: input.businessProfile.primary_color,
    userBubbleColor: input.businessProfile.user_bubble_color,
    botBubbleColor: input.businessProfile.bot_bubble_color,
    fontFamily: input.businessProfile.font_family,
    widgetPosition: input.businessProfile.widget_position,
    launcherStyle: input.businessProfile.launcher_style,
    windowWidth: input.businessProfile.window_width,
    windowHeight: input.businessProfile.window_height,
    borderRadius: input.businessProfile.border_radius,
    botName: input.businessProfile.bot_name,
    welcomeMessage: input.businessProfile.welcome_message,
    botAvatarUrl: input.businessProfile.bot_avatar_url || undefined
  };

  const reactSnippet = `<ChatWidget tenantId="${input.tenantId}" backendUrl="${backendUrl}" supportPhoneOverride="${input.businessProfile.support_phone || ""}" supportCtaLabelOverride="${input.businessProfile.support_cta_label}" appearanceOverride={${JSON.stringify(appearance, null, 2)}} />`;

  return {
    tenant_id: input.tenantId,
    enabled: true,
    status: "ready" as const,
    blocked_reason: null,
    widget_host_url: widgetHostUrl,
    backend_url: backendUrl,
    embed_url: embedUrl,
    script_snippet: script,
    react_snippet: reactSnippet
  };
}
