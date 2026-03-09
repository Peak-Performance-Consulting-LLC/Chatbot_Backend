import { chatsQuerySchema, createChatInputSchema } from "@/chat/schemas";
import { createChatThread, listChatThreads } from "@/chat/repository";
import { insertOpeningMessage } from "@/chat/opening";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = chatsQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id"),
      device_id: url.searchParams.get("device_id")
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

    await assertTenantDomainAccess(request, parsed.data.tenant_id);

    const chats = await listChatThreads(parsed.data.tenant_id, parsed.data.device_id);
    return jsonCorsResponse(request, { chats });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = createChatInputSchema.safeParse(body);

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

    await assertTenantDomainAccess(request, parsed.data.tenant_id);

    const chat = await createChatThread({
      tenant_id: parsed.data.tenant_id,
      device_id: parsed.data.device_id,
      title: parsed.data.title
    });
    await insertOpeningMessage(chat.id, parsed.data.tenant_id);

    return jsonCorsResponse(request, { chat }, 201);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
