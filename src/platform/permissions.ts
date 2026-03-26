import { HttpError } from "@/lib/httpError";
import {
  getWorkspaceRoleForUser,
  resolvePlatformSession,
  type WorkspaceRole
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
