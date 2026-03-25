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
    backend_url: backendUrl
  });
  const embedUrl = `${widgetHostUrl}/?${params.toString()}`;
  const widgetOrigin = new URL(widgetHostUrl).origin;

  const script = `<script>
(function () {
  var widgetOrigin = '${escapeAttribute(widgetOrigin)}';
  var layout = {
    widgetPosition: 'right',
    launcherStyle: 'rounded',
    launcherIconOnly: true,
    botName: 'Chat with us',
    windowWidth: 520,
    windowHeight: 820,
    borderRadius: 18
  };
  var activeMode = 'launcher';
  var iframe = document.createElement('iframe');
  iframe.src = '${escapeAttribute(embedUrl)}';
  iframe.title = 'Chat widget';
  iframe.style.position = 'fixed';
  iframe.style.bottom = '16px';
  iframe.style.maxWidth = 'calc(100vw - 24px)';
  iframe.style.maxHeight = 'calc(100vh - 24px)';
  iframe.style.border = '0';
  iframe.style.borderRadius = '0';
  iframe.style.overflow = 'hidden';
  iframe.style.zIndex = '2147483000';
  iframe.style.background = 'transparent';
  iframe.style.transition = 'width 220ms cubic-bezier(0.4, 0, 0.2, 1), height 220ms cubic-bezier(0.4, 0, 0.2, 1), border-radius 220ms cubic-bezier(0.4, 0, 0.2, 1)';
  iframe.allow = 'clipboard-write';
  iframe.setAttribute('scrolling', 'no');

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isCompactViewport() {
    return window.innerWidth <= 640 || window.innerHeight <= 760;
  }

  function applyPosition() {
    iframe.style.right = layout.widgetPosition === 'left' ? 'auto' : '16px';
    iframe.style.left = layout.widgetPosition === 'left' ? '16px' : 'auto';
  }

  function resolveSizing() {
    var desktopExpandedWidth = clamp(layout.windowWidth, 320, 560);
    var desktopExpandedHeight = clamp(layout.windowHeight + 78, 520, 938);
    var desktopPeekWidth = clamp(Math.min(layout.windowWidth, 376), 320, 376);
    var desktopPeekHeight = 344;
    var desktopExpandedRadius = clamp(layout.borderRadius, 8, 36);
    var label = (layout.botName || 'Chat with us').trim();
    var isIconOnly = Boolean(layout.launcherIconOnly);
    var iconOnlySize = layout.launcherStyle === 'minimal' ? 54 : 58;
    var desktopLauncherWidth = isIconOnly ? iconOnlySize : clamp(124 + clamp(label.length, 6, 24) * 7, 190, 284);
    var desktopLauncherHeight = isIconOnly ? iconOnlySize : layout.launcherStyle === 'minimal' ? 60 : 68;
    var desktopLauncherRadius =
      layout.launcherStyle === 'square'
        ? 20
        : layout.launcherStyle === 'minimal'
          ? 16
          : layout.launcherStyle === 'pill'
            ? 999
            : 24;

    if (!isCompactViewport()) {
      return {
        expandedWidth: desktopExpandedWidth,
        expandedHeight: desktopExpandedHeight,
        peekWidth: desktopPeekWidth,
        peekHeight: desktopPeekHeight,
        launcherWidth: desktopLauncherWidth,
        launcherHeight: desktopLauncherHeight,
        launcherRadius: desktopLauncherRadius,
        expandedRadius: desktopExpandedRadius
      };
    }

    return {
      expandedWidth: clamp(Math.min(desktopExpandedWidth, window.innerWidth - 32), 300, 350),
      expandedHeight: clamp(Math.min(desktopExpandedHeight, window.innerHeight - 164), 440, 560),
      compactWidth: clamp(Math.min(desktopExpandedWidth, window.innerWidth - 36), 296, 340),
      compactHeight: clamp(Math.min(desktopExpandedHeight, window.innerHeight - 260), 340, 430),
      peekWidth: clamp(Math.min(desktopPeekWidth, window.innerWidth - 40), 272, 320),
      peekHeight: clamp(Math.min(desktopPeekHeight, window.innerHeight - 220), 220, 284),
      launcherWidth: isIconOnly ? iconOnlySize : clamp(Math.min(desktopLauncherWidth, window.innerWidth - 36), 176, 236),
      launcherHeight: isIconOnly ? iconOnlySize : layout.launcherStyle === 'minimal' ? 54 : 58,
      launcherRadius:
        layout.launcherStyle === 'square'
          ? 18
          : layout.launcherStyle === 'minimal'
            ? 14
            : layout.launcherStyle === 'pill'
              ? 999
              : 20,
      expandedRadius: Math.min(desktopExpandedRadius, 20)
    };
  }

  function applyState(mode) {
    activeMode = mode;
    applyPosition();
    var sizing = resolveSizing();

    if (mode === 'open') {
      iframe.style.width = sizing.expandedWidth + 'px';
      iframe.style.height = sizing.expandedHeight + 'px';
      iframe.style.borderRadius = sizing.expandedRadius + 'px';
      return;
    }

    if (mode === 'open-compact') {
      iframe.style.width = (sizing.compactWidth || sizing.expandedWidth) + 'px';
      iframe.style.height = (sizing.compactHeight || sizing.expandedHeight) + 'px';
      iframe.style.borderRadius = sizing.expandedRadius + 'px';
      return;
    }

    if (mode === 'launcher') {
      iframe.style.width = sizing.launcherWidth + 'px';
      iframe.style.height = sizing.launcherHeight + 'px';
      iframe.style.borderRadius = sizing.launcherRadius + 'px';
      return;
    }

    iframe.style.width = sizing.peekWidth + 'px';
    iframe.style.height = sizing.peekHeight + 'px';
    iframe.style.borderRadius = '0';
  }

  applyState('launcher');
  document.body.appendChild(iframe);
  window.addEventListener('resize', function () {
    applyState(activeMode);
  });

  window.addEventListener('message', function (event) {
    if (!event || event.origin !== widgetOrigin) return;
    if (event.source !== iframe.contentWindow) return;
    if (!event.data) return;
    if (event.data.type === 'aeroconcierge:widget-layout') {
      var nextLayout = event.data.layout || {};
      if (nextLayout.widgetPosition === 'left' || nextLayout.widgetPosition === 'right') {
        layout.widgetPosition = nextLayout.widgetPosition;
      }
      if (
        nextLayout.launcherStyle === 'rounded' ||
        nextLayout.launcherStyle === 'pill' ||
        nextLayout.launcherStyle === 'square' ||
        nextLayout.launcherStyle === 'minimal'
      ) {
        layout.launcherStyle = nextLayout.launcherStyle;
      }
      if (typeof nextLayout.launcherIconOnly === 'boolean') {
        layout.launcherIconOnly = nextLayout.launcherIconOnly;
      }
      if (typeof nextLayout.botName === 'string' && nextLayout.botName.trim()) {
        layout.botName = nextLayout.botName.trim().slice(0, 42);
      }
      if (typeof nextLayout.windowWidth === 'number' && isFinite(nextLayout.windowWidth)) {
        layout.windowWidth = clamp(Math.round(nextLayout.windowWidth), 320, 560);
      }
      if (typeof nextLayout.windowHeight === 'number' && isFinite(nextLayout.windowHeight)) {
        layout.windowHeight = clamp(Math.round(nextLayout.windowHeight), 520, 860);
      }
      if (typeof nextLayout.borderRadius === 'number' && isFinite(nextLayout.borderRadius)) {
        layout.borderRadius = clamp(Math.round(nextLayout.borderRadius), 8, 36);
      }
      applyState(activeMode);
      return;
    }
    if (event.data.type !== 'aeroconcierge:widget-state') return;
    var nextMode = event.data.mode;
    if (nextMode !== 'open' && nextMode !== 'open-compact' && nextMode !== 'peek' && nextMode !== 'launcher') {
      nextMode = event.data.open ? 'open' : 'launcher';
    }
    applyState(nextMode);
  });
})();
</script>`;

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
