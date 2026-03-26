import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { resolvePlatformSession } from "@/platform/repository";
import { acceptWorkspaceInvitation } from "@/services/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().trim().min(16).max(256)
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * POST /api/platform/team/invitations/accept
 * Accepts an invitation token for the authenticated user.
 */
export async function POST(request: Request) {
  try {
    const authToken = parseBearerToken(request);
    const user = await resolvePlatformSession(authToken);
    const raw = await request.json();
    const parsed = bodySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    const result = await acceptWorkspaceInvitation({
      token: parsed.data.token,
      actorUserId: user.id,
      actorEmail: user.email
    });

    return jsonCorsResponse(request, result, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
