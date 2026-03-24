import {
  assertChatOwnership,
  getVisitorContactByTenantDevice,
  insertChatMessage,
  touchChatThread,
  upsertVisitorContact
} from "@/chat/repository";
import { visitorContactInputSchema } from "@/chat/schemas";
import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

function toDisplayName(input: string) {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!trimmed) return "there";
  return trimmed.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const parsed = visitorContactInputSchema.safeParse(raw);

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
    const existingContact = await getVisitorContactByTenantDevice(parsed.data.tenant_id, parsed.data.device_id);

    if (parsed.data.chat_id) {
      await assertChatOwnership(parsed.data.chat_id, parsed.data.tenant_id, parsed.data.device_id);
    }

    const contact = await upsertVisitorContact({
      tenant_id: parsed.data.tenant_id,
      device_id: parsed.data.device_id,
      chat_id: parsed.data.chat_id,
      full_name: parsed.data.full_name,
      email: parsed.data.email,
      phone: parsed.data.phone
    });

    let greetingMessage = null;
    if (!existingContact && parsed.data.chat_id) {
      const displayName = toDisplayName(parsed.data.full_name);
      greetingMessage = await insertChatMessage({
        chat_id: parsed.data.chat_id,
        role: "assistant",
        content: `Thanks, ${displayName}. Nice to meet you. How can I help you next?`
      });
      await touchChatThread(parsed.data.chat_id);
    }

    return jsonCorsResponse(request, { ok: true, contact, greeting_message: greetingMessage }, 200);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
