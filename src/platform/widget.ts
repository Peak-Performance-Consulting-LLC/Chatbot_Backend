import { getEnv } from "@/config/env";

function ensureBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export function buildWidgetConfig(tenantId: string) {
  const env = getEnv();
  const widgetHostUrl = ensureBaseUrl(env.WIDGET_HOST_URL);
  const backendUrl = ensureBaseUrl(env.BACKEND_PUBLIC_URL);
  const embedUrl = `${widgetHostUrl}/?embed=1&tenant_id=${encodeURIComponent(tenantId)}&backend_url=${encodeURIComponent(backendUrl)}`;

  const script = `<script>
(function () {
  var iframe = document.createElement('iframe');
  iframe.src = '${embedUrl}';
  iframe.title = 'AeroConcierge Chat';
  iframe.style.position = 'fixed';
  iframe.style.right = '16px';
  iframe.style.bottom = '16px';
  iframe.style.width = '380px';
  iframe.style.height = '640px';
  iframe.style.maxWidth = 'calc(100vw - 24px)';
  iframe.style.maxHeight = 'calc(100vh - 24px)';
  iframe.style.border = '0';
  iframe.style.zIndex = '2147483000';
  iframe.style.background = 'transparent';
  iframe.allow = 'clipboard-write';
  document.body.appendChild(iframe);
})();
</script>`;

  const reactSnippet = `<ChatWidget tenantId="${tenantId}" backendUrl="${backendUrl}" />`;

  return {
    tenant_id: tenantId,
    widget_host_url: widgetHostUrl,
    backend_url: backendUrl,
    embed_url: embedUrl,
    script_snippet: script,
    react_snippet: reactSnippet
  };
}

