import { parseBearerToken } from "@/platform/auth";
import { platformTenantProfileSchema } from "@/platform/schemas";
import { updatePlatformTenantProfile } from "@/platform/service";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { clearTenantCache } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function PATCH(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformTenantProfileSchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        {
          error: "Invalid request payload",
          details: parsed.error.flatten()
        },
        400
      );
    }

    const result = await updatePlatformTenantProfile({
      token,
      tenant_id: parsed.data.tenant_id,
      business_type: parsed.data.business_type,
      supported_services: parsed.data.supported_services,
      support_phone: parsed.data.support_phone,
      support_email: parsed.data.support_email,
      support_cta_label: parsed.data.support_cta_label,
      header_cta_label: parsed.data.header_cta_label,
      header_cta_notice: parsed.data.header_cta_notice,
      business_description: parsed.data.business_description,
      primary_color: parsed.data.primary_color,
      user_bubble_color: parsed.data.user_bubble_color,
      bot_bubble_color: parsed.data.bot_bubble_color,
      font_family: parsed.data.font_family,
      widget_position: parsed.data.widget_position,
      launcher_style: parsed.data.launcher_style,
      theme_style: parsed.data.theme_style,
      bg_pattern: parsed.data.bg_pattern,
      launcher_icon: parsed.data.launcher_icon,
      window_width: parsed.data.window_width,
      window_height: parsed.data.window_height,
      border_radius: parsed.data.border_radius,
      welcome_message: parsed.data.welcome_message,
      bot_name: parsed.data.bot_name,
      bot_avatar_url: parsed.data.bot_avatar_url,
      quick_replies: parsed.data.quick_replies,
      ai_tone: parsed.data.ai_tone,
      notif_enabled: parsed.data.notif_enabled,
      notif_text: parsed.data.notif_text,
      notif_animation: parsed.data.notif_animation,
      notif_chips: parsed.data.notif_chips
    });

    // Immediately evict in-process cache so widget-config returns fresh values
    clearTenantCache(parsed.data.tenant_id);

    return jsonCorsResponse(request, result, 200);

  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
