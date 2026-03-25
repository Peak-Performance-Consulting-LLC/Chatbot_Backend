import { getEnv } from "@/config/env";
import type { TenantBusinessProfile } from "@/platform/repository";

function ensureBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
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
    backend_url: backendUrl
  });
  const embedUrl = `${widgetHostUrl}/?${params.toString()}`;

  const embedJsUrl = `${backendUrl}/api/embed?tenant_id=${encodeURIComponent(input.tenantId)}`;

  const script = `<script src="${embedJsUrl}"></script>`;

  const reactSnippet = `<ChatWidget tenantId="${input.tenantId}" backendUrl="${backendUrl}" />`;

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
