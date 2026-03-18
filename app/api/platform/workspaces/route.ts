import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { platformCreateWorkspaceSchema } from "@/platform/schemas";
import { createPlatformWorkspace } from "@/platform/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function POST(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = platformCreateWorkspaceSchema.safeParse(raw);

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

    const result = await createPlatformWorkspace({
      token,
      company_name: parsed.data.company_name,
      website_url: parsed.data.website_url,
      sitemap_url: parsed.data.sitemap_url,
      faq_text: parsed.data.faq_text,
      doc_urls: parsed.data.doc_urls,
      business_type: parsed.data.business_type,
      supported_services: parsed.data.supported_services,
      support_phone: parsed.data.support_phone,
      support_email: parsed.data.support_email,
      support_cta_label: parsed.data.support_cta_label,
      business_description: parsed.data.business_description
    });

    return jsonCorsResponse(request, result, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
