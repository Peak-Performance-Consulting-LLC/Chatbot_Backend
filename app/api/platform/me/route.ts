import { parseBearerToken } from "@/platform/auth";
import { getPlatformProfile, updatePlatformUserProfile } from "@/platform/service";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { platformUpdateUserSchema } from "@/platform/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const profile = await getPlatformProfile(token);
    return jsonCorsResponse(request, profile, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

export async function PATCH(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();

    const parsed = platformUpdateUserSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const result = await updatePlatformUserProfile({ token, ...parsed.data });
    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
