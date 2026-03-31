import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { getWorkspaceLiveSupportAvailability } from "@/services/presence";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const widgetConfigQuerySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80)
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = widgetConfigQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id")
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid query parameters",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const tenant = await assertTenantDomainAccess(request, parsed.data.tenant_id);
    const liveSupport = await getWorkspaceLiveSupportAvailability(tenant.tenant_id).catch(() => ({
      availability: "offline" as const,
      online_count: 0,
      busy_count: 0,
      away_count: 0,
      updated_at: new Date().toISOString()
    }));

    return jsonCorsResponse(request, {
      tenant_id: tenant.tenant_id,
      appearance: {
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
        botAvatarUrl: tenant.bot_avatar_url || undefined,
        quickReplies: tenant.quick_replies,
        notifEnabled: tenant.notif_enabled,
        notifText: tenant.notif_text,
        notifAnimation: tenant.notif_animation,
        notifChips: tenant.notif_chips,
        csatEnabled: tenant.csat_enabled,
        csatPrompt: tenant.csat_prompt
      },
      supportPhone: tenant.support_phone || undefined,
      supportCtaLabel: tenant.support_cta_label,
      headerCtaLabel: tenant.header_cta_label,
      headerCtaNotice: tenant.header_cta_notice,
      live_support: liveSupport
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
