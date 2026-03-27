import { HttpError } from "@/lib/httpError";
import {
  getPrimaryPlatformUserIdForTenant,
  getSubscriptionByUserId,
  getWorkspaceRoleForUser,
  resolvePlatformSession,
  type WorkspaceRole,
  type SubscriptionSummary
} from "@/platform/repository";

export type WorkspacePermission =
  | "workspace:read"
  | "workspace:admin"
  | "team:manage"
  | "queue:manage"
  | "conversation:view"
  | "conversation:accept"
  | "conversation:reply"
  | "conversation:transfer"
  | "conversation:supervise"
  | "presence:update";

const PERMISSIONS_BY_ROLE: Record<WorkspaceRole, Set<WorkspacePermission>> = {
  owner: new Set([
    "workspace:read",
    "workspace:admin",
    "team:manage",
    "queue:manage",
    "conversation:view",
    "conversation:accept",
    "conversation:reply",
    "conversation:transfer",
    "conversation:supervise",
    "presence:update"
  ]),
  admin: new Set([
    "workspace:read",
    "workspace:admin",
    "team:manage",
    "queue:manage",
    "conversation:view",
    "conversation:accept",
    "conversation:reply",
    "conversation:transfer",
    "conversation:supervise",
    "presence:update"
  ]),
  supervisor: new Set([
    "workspace:read",
    "queue:manage",
    "conversation:view",
    "conversation:accept",
    "conversation:reply",
    "conversation:transfer",
    "conversation:supervise",
    "presence:update"
  ]),
  agent: new Set([
    "workspace:read",
    "conversation:view",
    "conversation:accept",
    "conversation:reply",
    "conversation:transfer",
    "presence:update"
  ]),
  viewer: new Set(["workspace:read", "conversation:view"])
};

export function hasWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return PERMISSIONS_BY_ROLE[role]?.has(permission) ?? false;
}

export async function requireWorkspacePermission(input: {
  token: string;
  workspaceId: string;
  permission: WorkspacePermission;
}) {
  const user = await resolvePlatformSession(input.token);
  const role = await getWorkspaceRoleForUser(user.id, input.workspaceId);
  if (!role) {
    throw new HttpError(403, "Workspace access denied");
  }
  if (!hasWorkspacePermission(role, input.permission)) {
    throw new HttpError(403, "You do not have permission to perform this action");
  }

  return {
    user,
    role
  };
}

function toPlanLabel(plan: string): string {
  switch (plan) {
    case "enterprise":
      return "Enterprise";
    case "growth":
      return "Growth";
    case "starter":
      return "Starter";
    default:
      return "Trial";
  }
}

function formatAllowedPlanLabels(plans: SubscriptionSummary["plan"][]): string {
  const labels = plans.map(toPlanLabel);
  if (labels.length <= 1) {
    return labels[0] ?? "Enterprise";
  }
  if (labels.length === 2) {
    return `${labels[0]} or ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export async function requireWorkspaceEnterprisePlan(input: {
  workspaceId: string;
  feature: string;
  allowedPlans?: SubscriptionSummary["plan"][];
}) {
  const allowedPlans = input.allowedPlans?.length
    ? input.allowedPlans
    : (["enterprise"] as SubscriptionSummary["plan"][]);

  const ownerUserId = await getPrimaryPlatformUserIdForTenant(input.workspaceId);
  if (!ownerUserId) {
    throw new HttpError(
      403,
      `${input.feature} requires an active ${formatAllowedPlanLabels(allowedPlans)} plan for this workspace.`
    );
  }

  const subscription = await getSubscriptionByUserId(ownerUserId);
  if (!subscription) {
    throw new HttpError(
      403,
      `${input.feature} requires an active ${formatAllowedPlanLabels(allowedPlans)} plan for this workspace.`
    );
  }

  if (subscription.status !== "active") {
    throw new HttpError(
      403,
      `${input.feature} requires an active ${formatAllowedPlanLabels(allowedPlans)} plan. Current subscription status is ${subscription.status}.`
    );
  }

  if (!allowedPlans.includes(subscription.plan)) {
    throw new HttpError(
      403,
      `${input.feature} is available on ${formatAllowedPlanLabels(allowedPlans)} only. Current plan: ${toPlanLabel(subscription.plan)}.`
    );
  }

  return subscription;
}
