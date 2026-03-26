import { z } from "zod";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { getWorkspacePresence, heartbeatPresence } from "@/services/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const heartbeatSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  status: z.enum(["online", "away", "offline"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const tenantId = (url.searchParams.get("tenant_id") ?? "").trim();
    if (!tenantId) {
      return jsonCorsResponse(request, { error: "tenant_id is required" }, 400);
    }

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: tenantId,
      permission: "workspace:read"
    });

    const presence = await getWorkspacePresence({
      workspaceId: tenantId,
      actorUserId: user.id
    });

    return jsonCorsResponse(request, {
      tenant_id: tenantId,
      presence
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

export async function POST(request: Request) {
  try {
    const token = parseBearerToken(request);
    const raw = await request.json();
    const parsed = heartbeatSchema.safeParse(raw);

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

    const { user } = await requireWorkspacePermission({
      token,
      workspaceId: parsed.data.tenant_id,
      permission: "presence:update"
    });

    await enforceAgentApiRateLimit(
      `agent_presence:${getClientIp(request)}:${parsed.data.tenant_id}:${user.id}`
    );

    const heartbeat = await heartbeatPresence({
      workspaceId: parsed.data.tenant_id,
      userId: user.id,
      status: parsed.data.status,
      metadata: parsed.data.metadata
    });

    return jsonCorsResponse(request, {
      tenant_id: parsed.data.tenant_id,
      heartbeat
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
