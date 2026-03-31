import { jsonCorsResponse, optionsCorsResponse } from "@/lib/cors";
import { enforceAgentApiRateLimit } from "@/lib/agentRateLimit";
import { HttpError, toHttpError } from "@/lib/httpError";
import { getClientIp } from "@/lib/request";
import {
  acceptConversation,
  getModeTransitionMessage,
  isHandoffEnabledForTenant,
  requestHandoffWithOptions
} from "@/services/conversation";
import { getQueueById, touchQueueMemberLastAssigned } from "@/agent/repository";
import {
  buildSlaTargetsForQueue,
  classifyRoutingSkill,
  findEligibleAgentForQueue,
  isWithinBusinessHours
} from "@/services/routing";
import { resolveConversationQueue } from "@/services/queue";
import {
  broadcastAgentNotification,
  broadcastModeChange,
  broadcastMessage,
  broadcastQueueConversation,
  broadcastWorkspaceInboxUpdate
} from "@/services/notification";
import {
  insertChatMessage,
  assertChatOwnership,
  getLatestUserMessage,
  getVisitorContactByTenantDevice
} from "@/chat/repository";
import { assertTenantDomainAccess } from "@/tenants/verifyTenant";
import { writeAuditLog } from "@/services/audit";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handoffBodySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  visitor_is_vip: z.boolean().optional(),
  routing_skill: z.string().trim().min(2).max(60).optional()
});

export async function OPTIONS(request: Request) {
  return optionsCorsResponse(request);
}

function isCompleteVisitorContact(contact: {
  full_name?: string | null;
  email?: string | null;
  phone_raw?: string | null;
} | null) {
  if (!contact) {
    return false;
  }
  return Boolean(contact.full_name?.trim() && contact.email?.trim() && contact.phone_raw?.trim());
}

function formatWaitingEtaLabel(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) {
    return "less than a minute";
  }
  const minutes = Math.ceil(safeSeconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
  }
  const hourPart = hours === 1 ? "1 hour" : `${hours} hours`;
  return `about ${hourPart} ${remainingMinutes} minutes`;
}

function computeWaitingEta(dueAt: string | null | undefined): {
  waitingEtaSeconds: number | null;
  waitingEtaLabel: string | null;
} {
  if (!dueAt) {
    return {
      waitingEtaSeconds: null,
      waitingEtaLabel: null
    };
  }
  const dueTs = new Date(dueAt).getTime();
  if (!Number.isFinite(dueTs)) {
    return {
      waitingEtaSeconds: null,
      waitingEtaLabel: null
    };
  }
  const remainingSeconds = Math.max(0, Math.ceil((dueTs - Date.now()) / 1000));
  return {
    waitingEtaSeconds: remainingSeconds,
    waitingEtaLabel: formatWaitingEtaLabel(remainingSeconds)
  };
}

/**
 * POST /api/conversation/[id]/handoff
 * Visitor requests handoff to a live agent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const raw = await request.json();
    const parsed = handoffBodySchema.safeParse(raw);

    if (!parsed.success) {
      return jsonCorsResponse(
        request,
        { error: "Invalid request payload", details: parsed.error.flatten() },
        400
      );
    }

    await enforceAgentApiRateLimit(
      `handoff:${getClientIp(request)}:${parsed.data.tenant_id}:${parsed.data.device_id}`
    );

    await assertTenantDomainAccess(request, parsed.data.tenant_id);

    // Verify the visitor owns this conversation
    const chat = await assertChatOwnership(chatId, parsed.data.tenant_id, parsed.data.device_id);
    const inferredUserMessage = await getLatestUserMessage(chatId).catch(() => null);
    const inferredSkill =
      parsed.data.routing_skill?.trim().toLowerCase() ||
      classifyRoutingSkill(
        `${inferredUserMessage?.content ?? ""} ${(inferredUserMessage?.metadata?.intent as string | undefined) ?? ""}`
      );
    const visitorIsVip = parsed.data.visitor_is_vip ?? chat.visitor_is_vip ?? false;

    if (!isHandoffEnabledForTenant(parsed.data.tenant_id)) {
      throw new HttpError(403, "Live agent handoff is not enabled for this tenant.");
    }

    const visitorContact = await getVisitorContactByTenantDevice(
      parsed.data.tenant_id,
      parsed.data.device_id
    );
    if (!isCompleteVisitorContact(visitorContact)) {
      return jsonCorsResponse(
        request,
        {
          error: "Please share your name, email, and phone before connecting to a live agent.",
          requires_contact_capture: true
        },
        409
      );
    }

    // Queue-aware handoff: conversation must belong to an active queue.
    const queueResolution = await resolveConversationQueue({
      ...chat,
      visitor_is_vip: visitorIsVip,
      routing_skill: inferredSkill
    });
    if (!queueResolution.queueId) {
      throw new HttpError(
        409,
        "Live agent handoff is currently unavailable because no active queue is configured."
      );
    }

    const workspaceId = chat.workspace_id ?? chat.tenant_id;
    const queue = await getQueueById(queueResolution.queueId);
    if (!queue) {
      throw new HttpError(404, "Queue not found");
    }

    let targetQueue = queue;
    const withinBusinessHours = isWithinBusinessHours(queue.business_hours, new Date());

    if (!withinBusinessHours) {
      if (queue.after_hours_action === "overflow") {
        let overflowResolved = false;
        if (queue.overflow_queue_id) {
          const overflowQueue = await getQueueById(queue.overflow_queue_id);
          if (overflowQueue && overflowQueue.is_active && overflowQueue.workspace_id === queue.workspace_id) {
            targetQueue = overflowQueue;
            overflowResolved = true;
          }
        }

        if (!overflowResolved) {
          const msg = await insertChatMessage({
            chat_id: chatId,
            role: "system",
            content: "Our live team is currently offline and overflow routing is unavailable. The AI assistant will continue helping for now.",
            sender_type: "system",
            metadata: {
              after_hours: true,
              after_hours_action: "overflow",
              queue_id: queue.id
            }
          });

          await Promise.all([
            broadcastMessage(chatId, msg),
            broadcastModeChange(chatId, chat.conversation_mode ?? "ai_only", {
              queue_id: queue.id,
              after_hours: true,
              after_hours_action: "overflow"
            }),
            writeAuditLog({
              workspaceId,
              action: "conversation.handoff_after_hours_overflow_unavailable",
              actorUserId: null,
              targetType: "conversation",
              targetId: chatId,
              ipAddress: request.headers.get("x-forwarded-for"),
              metadata: {
                queue_id: queue.id
              }
            })
          ]);

          return jsonCorsResponse(request, {
            chat_id: chatId,
            mode: chat.conversation_mode ?? "ai_only",
            status: chat.conversation_status ?? "active",
            queue_id: queue.id,
            after_hours: true,
            after_hours_action: "overflow"
          });
        }
      } else {
        const afterHoursMessage =
          queue.after_hours_action === "collect_info"
            ? "Our live team is currently offline. Please share your contact details and we will follow up when we reopen."
            : "Our live team is currently offline. The AI assistant will continue helping for now.";

        const msg = await insertChatMessage({
          chat_id: chatId,
          role: "system",
          content: afterHoursMessage,
          sender_type: "system",
          metadata: {
            after_hours: true,
            after_hours_action: queue.after_hours_action,
            queue_id: queue.id
          }
        });

        await Promise.all([
          broadcastMessage(chatId, msg),
          broadcastModeChange(chatId, chat.conversation_mode ?? "ai_only", {
            queue_id: queue.id,
            after_hours: true,
            after_hours_action: queue.after_hours_action
          }),
          writeAuditLog({
            workspaceId,
            action: "conversation.handoff_after_hours_blocked",
            actorUserId: null,
            targetType: "conversation",
            targetId: chatId,
            ipAddress: request.headers.get("x-forwarded-for"),
            metadata: {
              queue_id: queue.id,
              after_hours_action: queue.after_hours_action
            }
          })
        ]);

        return jsonCorsResponse(request, {
          chat_id: chatId,
          mode: chat.conversation_mode ?? "ai_only",
          status: chat.conversation_status ?? "active",
          queue_id: queue.id,
          after_hours: true,
          after_hours_action: queue.after_hours_action
        });
      }
    }

    const now = new Date();
    const slaTargets = buildSlaTargetsForQueue(targetQueue, now);
    let allAgentsBusy = false;
    let waitingEtaSeconds: number | null = null;
    let waitingEtaLabel: string | null = null;

    // Transition to handoff_pending
    const updated = await requestHandoffWithOptions(chatId, {
      metadata: {
        queue_id: targetQueue.id,
        after_hours: !withinBusinessHours,
        after_hours_action: queue.after_hours_action
      },
      updates: {
        queue_id: targetQueue.id,
        workspace_id: workspaceId,
        visitor_is_vip: visitorIsVip,
        routing_skill: inferredSkill,
        handoff_requested_at: now.toISOString(),
        sla_started_at: slaTargets.sla_started_at,
        sla_first_response_due_at: slaTargets.sla_first_response_due_at,
        first_agent_response_at: null,
        sla_warning_sent_at: null,
        sla_breached: false,
        sla_breached_at: null
      }
    });

    await writeAuditLog({
      workspaceId,
      action: "conversation.handoff_requested",
      actorUserId: null,
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        queue_id: targetQueue.id,
        visitor_is_vip: visitorIsVip,
        routing_skill: inferredSkill,
        after_hours: !withinBusinessHours,
        after_hours_action: queue.after_hours_action
      }
    });

    // Insert system message
    const systemMessage = getModeTransitionMessage("handoff_pending");
    if (systemMessage) {
      const msg = await insertChatMessage({
        chat_id: chatId,
        role: "system",
        content: systemMessage,
        sender_type: "system",
        metadata: { mode_change: "handoff_pending" }
      });
      await broadcastMessage(chatId, msg);
    }

    // Broadcast mode change to realtime subscribers
    await broadcastModeChange(chatId, "handoff_pending", {
      queue_id: targetQueue.id
    });
    await broadcastWorkspaceInboxUpdate(workspaceId, {
      chat_id: chatId,
      tenant_id: parsed.data.tenant_id,
      queue_id: targetQueue.id,
      mode: "handoff_pending",
      reason: "chat_waiting_started",
      awaiting_agent_reply: true,
      waiting_age_seconds: 0,
      waiting_urgency: "normal"
    });

    // Auto-assign routing path
    if (targetQueue.routing_mode === "auto_assign") {
      const eligibleAgent = await findEligibleAgentForQueue(targetQueue.id, {
        requiredSkill: inferredSkill,
        isVip: visitorIsVip,
        routingStrategy: targetQueue.routing_strategy
      });

      if (eligibleAgent) {
        const assigned = await acceptConversation(chatId, eligibleAgent.userId);
        await touchQueueMemberLastAssigned({
          queue_id: targetQueue.id,
          user_id: eligibleAgent.userId
        }).catch(() => undefined);

        const joinedMessage = getModeTransitionMessage("agent_active", eligibleAgent.fullName);
        if (joinedMessage) {
          const msg = await insertChatMessage({
            chat_id: chatId,
            role: "system",
            content: joinedMessage,
            sender_type: "system",
            metadata: {
              mode_change: "agent_active",
              agent_id: eligibleAgent.userId,
              agent_name: eligibleAgent.fullName,
              agent_avatar_url: eligibleAgent.avatarUrl
            }
          });
          await broadcastMessage(chatId, msg);
        }

        await broadcastModeChange(chatId, "agent_active", {
          queue_id: targetQueue.id,
          agent_id: eligibleAgent.userId,
          agent_name: eligibleAgent.fullName,
          agent_avatar_url: eligibleAgent.avatarUrl
        });
        await broadcastAgentNotification(eligibleAgent.userId, "assignment", {
          chat_id: chatId,
          mode: "agent_active",
          queue_id: targetQueue.id
        });
        await broadcastWorkspaceInboxUpdate(workspaceId, {
          chat_id: chatId,
          tenant_id: parsed.data.tenant_id,
          queue_id: targetQueue.id,
          mode: "agent_active",
          reason: "conversation_assigned",
          awaiting_agent_reply: false,
          waiting_age_seconds: null,
          waiting_urgency: null
        });
        await writeAuditLog({
          workspaceId,
          actorUserId: eligibleAgent.userId,
          action: "conversation.auto_assigned",
          targetType: "conversation",
          targetId: chatId,
          ipAddress: request.headers.get("x-forwarded-for"),
          metadata: {
            queue_id: targetQueue.id,
            agent_id: eligibleAgent.userId
          }
        });

        return jsonCorsResponse(request, {
          chat_id: chatId,
          mode: assigned.conversation_mode,
          status: assigned.conversation_status,
          queue_id: targetQueue.id,
          assigned_agent_id: assigned.assigned_agent_id,
          sla_first_response_due_at: assigned.sla_first_response_due_at,
          all_agents_busy: false,
          waiting_eta_seconds: null,
          waiting_eta_label: null
        });
      }

      allAgentsBusy = true;
      const eta = computeWaitingEta(updated.sla_first_response_due_at);
      waitingEtaSeconds = eta.waitingEtaSeconds;
      waitingEtaLabel = eta.waitingEtaLabel;

      const busyMessage = await insertChatMessage({
        chat_id: chatId,
        role: "system",
        content: waitingEtaLabel
          ? `All agents are currently busy. Estimated wait: ${waitingEtaLabel}.`
          : "All agents are currently busy. We will connect you shortly.",
        sender_type: "system",
        metadata: {
          queue_id: targetQueue.id,
          reason: "no_available_agents",
          waiting_eta_seconds: waitingEtaSeconds,
          waiting_eta_label: waitingEtaLabel
        }
      });
      await broadcastMessage(chatId, busyMessage);
    }

    // Manual-accept or no eligible auto-assign candidate.
    await broadcastQueueConversation(targetQueue.id, {
      chat_id: chatId,
      tenant_id: parsed.data.tenant_id,
      mode: "handoff_pending",
      queue_id: targetQueue.id
    });
    await broadcastWorkspaceInboxUpdate(workspaceId, {
      chat_id: chatId,
      tenant_id: parsed.data.tenant_id,
      queue_id: targetQueue.id,
      mode: "handoff_pending",
      reason: "conversation_queued",
      awaiting_agent_reply: true,
      waiting_age_seconds: 0,
      waiting_urgency: "normal"
    });
    await writeAuditLog({
      workspaceId,
      actorUserId: null,
      action: "conversation.queue_broadcasted",
      targetType: "conversation",
      targetId: chatId,
      ipAddress: request.headers.get("x-forwarded-for"),
      metadata: {
        queue_id: targetQueue.id
      }
    });

    return jsonCorsResponse(request, {
      chat_id: chatId,
      mode: updated.conversation_mode,
      status: updated.conversation_status,
      queue_id: targetQueue.id,
      sla_first_response_due_at: updated.sla_first_response_due_at,
      all_agents_busy: allAgentsBusy,
      waiting_eta_seconds: waitingEtaSeconds,
      waiting_eta_label: waitingEtaLabel
    });
  } catch (error) {
    const asHttpError = toHttpError(error);
    return jsonCorsResponse(request, { error: asHttpError.message }, asHttpError.status);
  }
}
