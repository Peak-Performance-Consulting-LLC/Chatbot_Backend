import { getEnv } from "@/config/env";
import { optionsCorsResponse } from "@/lib/cors";
import { getTenantById } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ensureBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

type EmbedAppearance = {
  primaryColor: string;
  userBubbleColor: string;
  botBubbleColor: string;
  fontFamily: string;
  widgetPosition: "left" | "right";
  launcherStyle: "rounded" | "pill" | "square" | "minimal";
  themeStyle: "standard" | "glass" | "clay" | "dark" | "minimal";
  bgPattern: "none" | "dots" | "grid" | "waves";
  launcherIcon: "chat" | "sparkle" | "headset" | "zap" | "heart";
  windowWidth: number;
  windowHeight: number;
  borderRadius: number;
  botName: string;
  welcomeMessage: string;
  botAvatarUrl: string;
  quickReplies: string[];
  notifEnabled: boolean;
  notifText: string;
  notifAnimation: "bounce" | "pulse" | "slide";
  notifChips: string[];
  supportPhone: string;
  supportCtaLabel: string;
  headerCtaLabel: string;
  headerCtaNotice: string;
};

const fallbackAppearance: EmbedAppearance = {
  primaryColor: "#006d77",
  userBubbleColor: "#006d77",
  botBubbleColor: "#edf6f9",
  fontFamily: "Manrope",
  widgetPosition: "right",
  launcherStyle: "rounded",
  themeStyle: "standard",
  bgPattern: "none",
  launcherIcon: "chat",
  windowWidth: 440,
  windowHeight: 760,
  borderRadius: 18,
  botName: "AeroConcierge",
  welcomeMessage: "Welcome. How can I help today?",
  botAvatarUrl: "",
  quickReplies: ["How does this work?", "Pricing plans", "Get support"],
  notifEnabled: true,
  notifText: "Need help?",
  notifAnimation: "bounce",
  notifChips: ["I have a question", "Tell me more"],
  supportPhone: "",
  supportCtaLabel: "Connect with a specialist",
  headerCtaLabel: "",
  headerCtaNotice: "Hi! I am your AI assistant. Ask me anything about your trip."
};

function appendAppearanceParams(params: URLSearchParams, appearance: EmbedAppearance) {
  params.set("primary_color", appearance.primaryColor);
  params.set("user_bubble_color", appearance.userBubbleColor);
  params.set("bot_bubble_color", appearance.botBubbleColor);
  params.set("font_family", appearance.fontFamily);
  params.set("widget_position", appearance.widgetPosition);
  params.set("launcher_style", appearance.launcherStyle);
  params.set("theme_style", appearance.themeStyle);
  params.set("bg_pattern", appearance.bgPattern);
  params.set("launcher_icon", appearance.launcherIcon);
  params.set("window_width", String(appearance.windowWidth));
  params.set("window_height", String(appearance.windowHeight));
  params.set("border_radius", String(appearance.borderRadius));
  params.set("bot_name", appearance.botName);
  params.set("welcome_message", appearance.welcomeMessage);
  if (appearance.botAvatarUrl) params.set("avatar_url", appearance.botAvatarUrl);
  if (!appearance.notifEnabled) params.set("notif_enabled", "0");
  params.set("notif_text", appearance.notifText);
  params.set("notif_animation", appearance.notifAnimation);
  for (const reply of appearance.quickReplies.slice(0, 6)) {
    params.append("quick_reply", reply);
  }
  for (const chip of appearance.notifChips.slice(0, 4)) {
    params.append("notif_chip", chip);
  }
  if (appearance.supportPhone) params.set("support_phone", appearance.supportPhone);
  params.set("support_cta_label", appearance.supportCtaLabel);
  params.set("header_cta_label", appearance.headerCtaLabel);
  params.set("header_cta_notice", appearance.headerCtaNotice);
}

async function getEmbedAppearance(tenantId: string): Promise<EmbedAppearance> {
  try {
    const tenant = await getTenantById(tenantId, { fresh: true });
    return {
      primaryColor: tenant.primary_color,
      userBubbleColor: tenant.user_bubble_color,
      botBubbleColor: tenant.bot_bubble_color,
      fontFamily: tenant.font_family,
      widgetPosition: tenant.widget_position,
      launcherStyle: tenant.launcher_style,
      themeStyle: tenant.theme_style,
      bgPattern: tenant.bg_pattern,
      launcherIcon: tenant.launcher_icon,
      windowWidth: tenant.window_width,
      windowHeight: tenant.window_height,
      borderRadius: tenant.border_radius,
      botName: tenant.bot_name,
      welcomeMessage: tenant.welcome_message,
      botAvatarUrl: tenant.bot_avatar_url || "",
      quickReplies: tenant.quick_replies,
      notifEnabled: tenant.notif_enabled,
      notifText: tenant.notif_text,
      notifAnimation: tenant.notif_animation,
      notifChips: tenant.notif_chips,
      supportPhone: tenant.support_phone || "",
      supportCtaLabel: tenant.support_cta_label,
      headerCtaLabel: tenant.header_cta_label,
      headerCtaNotice: tenant.header_cta_notice
    };
  } catch (error) {
    console.error("Failed to load tenant appearance for embed script", error);
    return fallbackAppearance;
  }
}

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) {
    return new Response("Missing tenant_id", { status: 400 });
  }

  const env = getEnv();
  const widgetHostUrl = ensureBaseUrl(env.WIDGET_HOST_URL);
  const backendUrl = ensureBaseUrl(env.BACKEND_PUBLIC_URL);
  const appearance = await getEmbedAppearance(tenantId);

  const params = new URLSearchParams({
    embed: "1",
    tenant_id: tenantId,
    backend_url: backendUrl
  });
  appendAppearanceParams(params, appearance);
  const embedUrl = `${widgetHostUrl}/?${params.toString()}`;
  const widgetOrigin = new URL(widgetHostUrl).origin;
  const initialLayout = {
    widgetPosition: appearance.widgetPosition,
    launcherStyle: appearance.launcherStyle,
    launcherIconOnly: true,
    botName: appearance.botName,
    windowWidth: Math.max(appearance.windowWidth, 520),
    windowHeight: Math.max(appearance.windowHeight, 820),
    borderRadius: appearance.borderRadius
  };
  const initialMode = appearance.notifEnabled ? "peek" : "launcher";

  const js = `(function () {
  var widgetOrigin = ${JSON.stringify(widgetOrigin)};
  var layout = ${JSON.stringify(initialLayout)};
  var activeMode = ${JSON.stringify(initialMode)};
  var measuredSizes = {};
  var iframe = document.createElement('iframe');
  iframe.src = ${JSON.stringify(embedUrl)};
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
  iframe.style.colorScheme = 'normal';
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
    var right = layout.widgetPosition === 'left' ? 'auto' : '16px';
    var left = layout.widgetPosition === 'left' ? '16px' : 'auto';
    iframe.style.right = right;
    iframe.style.left = left;
    if (hoverZone) {
      hoverZone.style.right = right;
      hoverZone.style.left = left;
    }
  }

  function resolveSizing() {
    var desktopExpandedWidth = clamp(layout.windowWidth, 320, 560);
    var desktopExpandedHeight = clamp(layout.windowHeight + 78, 520, 938);
    var desktopPeekWidth = clamp(Math.min(layout.windowWidth, 376), 320, 376);
    var desktopPeekHeight = 196;
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
      peekHeight: clamp(Math.min(desktopPeekHeight, window.innerHeight - 220), 96, 240),
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

  function getMeasuredSize(mode, sizing) {
    var measured = measuredSizes[mode];
    if (!measured) return null;
    var width = Number(measured.width);
    var height = Number(measured.height);
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
    var maxWidth = Math.max(260, Math.min(window.innerWidth - 24, mode === 'launcher' ? sizing.launcherWidth + 48 : 420));
    var maxHeight = Math.max(70, Math.min(window.innerHeight - 24, mode === 'launcher' ? sizing.launcherHeight + 24 : 360));
    return {
      width: clamp(Math.ceil(width), mode === 'launcher' ? 48 : 120, maxWidth),
      height: clamp(Math.ceil(height), mode === 'launcher' ? 48 : 58, maxHeight)
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
      iframe.style.pointerEvents = 'auto';
      hoverZone.style.display = 'none';
      return;
    }

    if (mode === 'open-compact') {
      iframe.style.width = (sizing.compactWidth || sizing.expandedWidth) + 'px';
      iframe.style.height = (sizing.compactHeight || sizing.expandedHeight) + 'px';
      iframe.style.borderRadius = sizing.expandedRadius + 'px';
      iframe.style.pointerEvents = 'auto';
      hoverZone.style.display = 'none';
      return;
    }

    iframe.style.pointerEvents = 'auto';
    hoverZone.style.display = 'none';
    hoverZone.style.pointerEvents = 'none';

    if (mode === 'launcher') {
      var measuredLauncher = getMeasuredSize('launcher', sizing);
      var launcherWidth = measuredLauncher ? measuredLauncher.width : sizing.launcherWidth;
      var launcherHeight = measuredLauncher ? measuredLauncher.height : sizing.launcherHeight;
      iframe.style.width = launcherWidth + 'px';
      iframe.style.height = launcherHeight + 'px';
      iframe.style.borderRadius = sizing.launcherRadius + 'px';
      hoverZone.style.width = launcherWidth + 'px';
      hoverZone.style.height = launcherHeight + 'px';
      hoverZone.style.borderRadius = sizing.launcherRadius + 'px';
      return;
    }

    var measuredPeek = getMeasuredSize('peek', sizing);
    var peekWidth = measuredPeek ? measuredPeek.width : sizing.peekWidth;
    var peekHeight = measuredPeek ? measuredPeek.height : sizing.peekHeight;
    iframe.style.width = peekWidth + 'px';
    iframe.style.height = peekHeight + 'px';
    iframe.style.borderRadius = '0';
    hoverZone.style.width = peekWidth + 'px';
    hoverZone.style.height = peekHeight + 'px';
    hoverZone.style.borderRadius = '0';
  }

  var hoverZone = document.createElement('div');
  hoverZone.style.position = 'fixed';
  hoverZone.style.bottom = '16px';
  hoverZone.style.zIndex = '2147483001';
  hoverZone.style.cursor = 'pointer';
  hoverZone.style.background = 'transparent';

  hoverZone.addEventListener('mouseenter', function () {
    iframe.style.pointerEvents = 'auto';
    hoverZone.style.pointerEvents = 'none';
  });
  hoverZone.addEventListener('click', function () {
    iframe.style.pointerEvents = 'auto';
    hoverZone.style.pointerEvents = 'none';
  });

  iframe.addEventListener('mouseleave', function () {
    if (activeMode !== 'open' && activeMode !== 'open-compact') {
      iframe.style.pointerEvents = 'auto';
      hoverZone.style.display = 'none';
      hoverZone.style.pointerEvents = 'none';
    }
  });

  applyState(activeMode);
  document.body.appendChild(iframe);
  document.body.appendChild(hoverZone);

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
    if (event.data.size && (nextMode === 'peek' || nextMode === 'launcher')) {
      measuredSizes[nextMode] = {
        width: event.data.size.width,
        height: event.data.size.height
      };
    }
    applyState(nextMode);
  });
})();`;

  return new Response(js, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
