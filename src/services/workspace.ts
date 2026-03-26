import { randomBytes } from "node:crypto";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";
import { logError } from "@/lib/logger";
import { hashOpaqueToken } from "@/platform/auth";
import { sendWorkspaceInvitationEmail } from "@/platform/email";
import {
  countActiveWorkspaceSeats,
  createWorkspaceInvitation,
  getWorkspaceInvitationByTokenHash,
  getWorkspaceSeatLimit,
  listWorkspaceInvitations,
  type WorkspaceInvitationRecord,
  markWorkspaceInvitationAccepted
} from "@/platform/repository";
import { writeAuditLog } from "@/services/audit";
import {
  findPlatformUserByEmail,
  getWorkspaceMemberByUser,
  listWorkspaceMembersWithUser,
  type WorkspaceMemberRole,
  upsertWorkspaceMember
} from "@/agent/repository";

const MANAGE_TEAM_ROLES: WorkspaceMemberRole[] = ["owner", "admin"];
const INVITE_TOKEN_TTL_DAYS = 7;

type TeamMemberView = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceMemberRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  user: {
    id: string;
    email: string;
    full_name: string;
    avatar_url: string | null;
  } | null;
};

export type WorkspaceInvitationView = {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceMemberRole;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  status: "pending" | "accepted" | "expired";
};

type MemberWithUserRow = Awaited<ReturnType<typeof listWorkspaceMembersWithUser>>[number];

function canManageTeam(role: WorkspaceMemberRole): boolean {
  return MANAGE_TEAM_ROLES.includes(role);
}

function normalizeInviteRole(input?: string): WorkspaceMemberRole {
  const role = (input ?? "agent").trim().toLowerCase();
  if (role === "owner" || role === "admin" || role === "supervisor" || role === "agent" || role === "viewer") {
    return role;
  }
  return "agent";
}

function consumesSeat(role: WorkspaceMemberRole): boolean {
  return role !== "viewer";
}

function mapMember(member: MemberWithUserRow): TeamMemberView {
  return {
    id: member.id,
    workspace_id: member.workspace_id,
    user_id: member.user_id,
    role: member.role,
    is_active: member.is_active,
    created_at: member.created_at,
    updated_at: member.updated_at,
    user: member.platform_user
      ? {
          id: member.platform_user.id,
          email: member.platform_user.email,
          full_name: member.platform_user.full_name,
          avatar_url: member.platform_user.avatar_url
        }
      : null
  };
}

function mapInvitation(invitation: WorkspaceInvitationRecord): WorkspaceInvitationView {
  const now = Date.now();
  const expiresAt = new Date(invitation.expires_at).getTime();
  const isExpired = Number.isFinite(expiresAt) && expiresAt <= now;
  const status = invitation.accepted_at
    ? "accepted"
    : isExpired
      ? "expired"
      : "pending";

  return {
    id: invitation.id,
    workspace_id: invitation.workspace_id,
    email: invitation.email,
    role: invitation.role,
    invited_by: invitation.invited_by,
    expires_at: invitation.expires_at,
    accepted_at: invitation.accepted_at,
    created_at: invitation.created_at,
    status
  };
}

async function assertSeatCapacity(workspaceId: string) {
  const [activeSeats, seatLimit] = await Promise.all([
    countActiveWorkspaceSeats(workspaceId),
    getWorkspaceSeatLimit(workspaceId)
  ]);

  if (activeSeats >= seatLimit) {
    throw new HttpError(409, "Workspace seat limit reached. Upgrade your plan to invite more members.");
  }
}

async function maybeSendInvitationEmail(input: {
  to: string;
  workspaceId: string;
  role: WorkspaceMemberRole;
  inviteUrl: string;
  expiresAt: string;
  inviterName?: string;
}) {
  const env = getEnv();
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return;
  }

  try {
    await sendWorkspaceInvitationEmail({
      to: input.to,
      workspaceName: input.workspaceId,
      role: input.role,
      inviteUrl: input.inviteUrl,
      expiresAt: input.expiresAt,
      inviterName: input.inviterName
    });
  } catch (error) {
    logError("workspace_invitation_email_failed", {
      workspace_id: input.workspaceId,
      to: input.to,
      role: input.role,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function listWorkspaceMembers(input: {
  workspaceId: string;
  actorUserId: string;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }

  const members = await listWorkspaceMembersWithUser(input.workspaceId);
  return members.map(mapMember);
}

export async function listWorkspaceInvitationsForActor(input: {
  workspaceId: string;
  actorUserId: string;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }
  if (!canManageTeam(actor.role)) {
    return [];
  }

  const invitations = await listWorkspaceInvitations(input.workspaceId);
  return invitations.map(mapInvitation);
}

export async function inviteWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  email: string;
  role?: string;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }
  if (!canManageTeam(actor.role)) {
    throw new HttpError(403, "Only workspace owners or admins can manage team members");
  }

  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new HttpError(400, "Email is required");
  }

  const requestedRole = normalizeInviteRole(input.role);
  if (consumesSeat(requestedRole)) {
    await assertSeatCapacity(input.workspaceId);
  }

  const existingUser = await findPlatformUserByEmail(email);
  if (existingUser) {
    const existingMember = await getWorkspaceMemberByUser(input.workspaceId, existingUser.id);
    if (existingMember?.is_active) {
      throw new HttpError(409, "This user is already an active workspace member.");
    }
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const inviteUrl = new URL("/platform/login", getEnv().PLATFORM_APP_URL);
  inviteUrl.searchParams.set("invite", token);

  const invitation = await createWorkspaceInvitation({
    workspace_id: input.workspaceId,
    email,
    role: requestedRole,
    token_hash: tokenHash,
    invited_by: input.actorUserId,
    expires_at: expiresAt
  });

  await maybeSendInvitationEmail({
    to: email,
    workspaceId: input.workspaceId,
    role: requestedRole,
    inviteUrl: inviteUrl.toString(),
    expiresAt
  });

  await writeAuditLog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: "member.invited",
    targetType: "workspace_invitation",
    targetId: invitation.id,
    metadata: {
      email,
      role: requestedRole
    }
  });

  return {
    invitation: mapInvitation(invitation),
    invite_token: token,
    invite_url: inviteUrl.toString()
  };
}

export async function updateWorkspaceMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceMemberRole;
}) {
  const actor = await getWorkspaceMemberByUser(input.workspaceId, input.actorUserId);
  if (!actor) {
    throw new HttpError(403, "Workspace access denied");
  }
  if (!canManageTeam(actor.role)) {
    throw new HttpError(403, "Only workspace owners or admins can manage team members");
  }

  const targetMember = await getWorkspaceMemberByUser(input.workspaceId, input.targetUserId);
  if (!targetMember || !targetMember.is_active) {
    throw new HttpError(404, "Target workspace member was not found");
  }
  if (targetMember.role === "owner" && input.role !== "owner") {
    throw new HttpError(409, "Owner role cannot be changed from this endpoint");
  }

  if (!consumesSeat(targetMember.role) && consumesSeat(input.role)) {
    await assertSeatCapacity(input.workspaceId);
  }

  const updated = await upsertWorkspaceMember({
    workspace_id: input.workspaceId,
    user_id: input.targetUserId,
    role: input.role,
    created_by: input.actorUserId
  });

  await writeAuditLog({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: "member.role_updated",
    targetType: "workspace_member",
    targetId: updated.id,
    metadata: {
      user_id: input.targetUserId,
      role: input.role
    }
  });

  const members = await listWorkspaceMembersWithUser(input.workspaceId);
  const member = members.find((row) => row.user_id === input.targetUserId);
  if (!member) {
    throw new HttpError(500, "Role update succeeded but member could not be loaded");
  }

  return mapMember(member);
}

export async function acceptWorkspaceInvitation(input: {
  token: string;
  actorUserId: string;
  actorEmail: string;
}) {
  const rawToken = input.token.trim();
  if (!rawToken) {
    throw new HttpError(400, "Invitation token is required");
  }

  const tokenHash = hashOpaqueToken(rawToken);
  const invitation = await getWorkspaceInvitationByTokenHash(tokenHash);
  if (!invitation) {
    throw new HttpError(404, "Invitation not found");
  }

  const emailMatches = invitation.email.trim().toLowerCase() === input.actorEmail.trim().toLowerCase();
  if (!emailMatches) {
    throw new HttpError(403, "This invitation belongs to a different email address");
  }

  const expiresAt = new Date(invitation.expires_at).getTime();
  if (!invitation.accepted_at && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new HttpError(410, "Invitation has expired");
  }

  const roleToApply = normalizeInviteRole(invitation.role);
  const existingMember = await getWorkspaceMemberByUser(invitation.workspace_id, input.actorUserId);
  const roleBefore = existingMember?.role ?? null;

  if (!existingMember || !existingMember.is_active) {
    if (consumesSeat(roleToApply)) {
      await assertSeatCapacity(invitation.workspace_id);
    }
  } else if (!consumesSeat(existingMember.role) && consumesSeat(roleToApply)) {
    await assertSeatCapacity(invitation.workspace_id);
  }

  const appliedRole = existingMember?.role === "owner" ? "owner" : roleToApply;
  await upsertWorkspaceMember({
    workspace_id: invitation.workspace_id,
    user_id: input.actorUserId,
    role: appliedRole,
    created_by: invitation.invited_by ?? undefined
  });

  await markWorkspaceInvitationAccepted(invitation.id);
  await writeAuditLog({
    workspaceId: invitation.workspace_id,
    actorUserId: input.actorUserId,
    action: "member.invitation_accepted",
    targetType: "workspace_invitation",
    targetId: invitation.id,
    metadata: {
      email: invitation.email,
      role_before: roleBefore,
      role_after: appliedRole
    }
  });

  const members = await listWorkspaceMembersWithUser(invitation.workspace_id);
  const member = members.find((row) => row.user_id === input.actorUserId);
  if (!member) {
    throw new HttpError(500, "Invitation accepted but workspace member was not found");
  }

  return {
    member: mapMember(member),
    invitation: mapInvitation({
      ...invitation,
      accepted_at: new Date().toISOString()
    })
  };
}
