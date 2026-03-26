import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { toHttpError } from "@/lib/httpError";
import { parseBearerToken } from "@/platform/auth";
import { requireWorkspacePermission } from "@/platform/permissions";
import { platformConversationExportQuerySchema } from "@/platform/schemas";
import {
  getTenantRetentionSettings,
  listConversationsForExport,
  listConversationEventsForChats,
  listMessagesForChats
} from "@/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeCsv(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

/**
 * GET /api/platform/conversations/export?tenant_id=...&format=json|csv
 */
export async function GET(request: Request) {
  try {
    const token = parseBearerToken(request);
    const url = new URL(request.url);
    const parsed = platformConversationExportQuerySchema.safeParse({
      tenant_id: url.searchParams.get("tenant_id") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
      start_at: url.searchParams.get("start_at") ?? undefined,
      end_at: url.searchParams.get("end_at") ?? undefined,
      include_messages: url.searchParams.get("include_messages") ?? undefined,
      include_events: url.searchParams.get("include_events") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined
    });

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid export query", details: parsed.error.flatten() },
        400
      );
    }

    await requireWorkspacePermission({
      token,
      workspaceId: parsed.data.tenant_id,
      permission: "conversation:view"
    });

    const retention = await getTenantRetentionSettings(parsed.data.tenant_id);
    if (!retention.allow_conversation_export) {
      return jsonCorsResponse(
        request,
        { error: "Conversation export is disabled for this workspace." },
        403
      );
    }

    const { conversations, total } = await listConversationsForExport({
      tenant_id: parsed.data.tenant_id,
      start_at: parsed.data.start_at,
      end_at: parsed.data.end_at,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
    const chatIds = conversations.map((row) => row.id);

    const [messages, events] = await Promise.all([
      parsed.data.include_messages ? listMessagesForChats(chatIds) : Promise.resolve([]),
      parsed.data.include_events ? listConversationEventsForChats(chatIds) : Promise.resolve([])
    ]);

    if (parsed.data.format === "csv") {
      const messageCountByChat = new Map<string, number>();
      for (const row of messages) {
        messageCountByChat.set(row.chat_id, (messageCountByChat.get(row.chat_id) ?? 0) + 1);
      }
      const eventCountByChat = new Map<string, number>();
      for (const row of events) {
        eventCountByChat.set(row.chat_id, (eventCountByChat.get(row.chat_id) ?? 0) + 1);
      }

      const lines = [
        [
          "conversation_id",
          "tenant_id",
          "device_id",
          "title",
          "mode",
          "status",
          "assigned_agent_id",
          "visitor_is_vip",
          "routing_skill",
          "created_at",
          "last_message_at",
          "message_count",
          "event_count"
        ].join(",")
      ];

      for (const row of conversations) {
        lines.push(
          [
            row.id,
            row.tenant_id,
            row.device_id,
            row.title,
            row.conversation_mode,
            row.conversation_status,
            row.assigned_agent_id ?? "",
            row.visitor_is_vip ? "1" : "0",
            row.routing_skill ?? "",
            row.created_at,
            row.last_message_at,
            messageCountByChat.get(row.id) ?? 0,
            eventCountByChat.get(row.id) ?? 0
          ]
            .map(escapeCsv)
            .join(",")
        );
      }

      const filename = `conversation_export_${parsed.data.tenant_id}_${new Date().toISOString().slice(0, 10)}.csv`;
      return new Response(lines.join("\n"), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`
        }
      });
    }

    return jsonCorsResponse(request, {
      tenant_id: parsed.data.tenant_id,
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      export: {
        generated_at: new Date().toISOString(),
        conversations,
        ...(parsed.data.include_messages ? { messages } : {}),
        ...(parsed.data.include_events ? { events } : {})
      }
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}

