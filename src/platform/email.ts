import dns from "node:dns/promises";
import nodemailer from "nodemailer";
import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";

type PasswordResetEmailInput = {
  to: string;
  fullName: string;
  resetUrl: string;
  expiresInMinutes: number;
};

type WorkspaceInvitationEmailInput = {
  to: string;
  workspaceName: string;
  role: "owner" | "admin" | "supervisor" | "agent" | "viewer";
  inviteUrl: string;
  expiresAt: string;
  inviterName?: string;
};

let transporterPromise: Promise<ReturnType<typeof nodemailer.createTransport>> | null = null;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function resolveSmtpConnectionHost(hostname: string): Promise<string> {
  try {
    const records = await dns.resolve4(hostname);
    return records[0] || hostname;
  } catch {
    return hostname;
  }
}

function getTransporter() {
  const env = getEnv();
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new HttpError(500, "SMTP is not configured for password reset emails.");
  }

  if (!transporterPromise) {
    transporterPromise = resolveSmtpConnectionHost(env.SMTP_HOST).then((connectionHost) =>
      nodemailer.createTransport({
        host: connectionHost,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        dnsTimeout: 15000,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS
        },
        tls: {
          servername: env.SMTP_HOST
        }
      })
    );
  }

  return transporterPromise;
}

export async function sendPlatformPasswordResetEmail(input: PasswordResetEmailInput) {
  const env = getEnv();
  const transporter = await getTransporter();
  const safeName = escapeHtml(input.fullName.trim() || "there");
  const safeUrl = escapeHtml(input.resetUrl);
  const safeExpiry = `${input.expiresInMinutes} minute${input.expiresInMinutes === 1 ? "" : "s"}`;
  const fromAddress = env.SMTP_FROM || env.SMTP_USER;

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: input.to,
      subject: "Reset your account password",
      text: [
        `Hi ${input.fullName.trim() || "there"},`,
        "",
        "We received a request to reset your password.",
        `Reset it here: ${input.resetUrl}`,
        "",
        `This link expires in ${safeExpiry}.`,
        "If you did not request this, you can ignore this email."
      ].join("\n"),
      html: `
        <div style="background:#f6f1e7;padding:32px 18px;font-family:Georgia,'Times New Roman',serif;color:#181414;">
          <div style="max-width:560px;margin:0 auto;background:#fffaf3;border:1px solid rgba(24,20,20,0.08);border-radius:24px;padding:32px;">
            <p style="margin:0 0 10px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#8c6a32;">AeroConcierge</p>
            <h1 style="margin:0 0 16px;font-size:32px;font-weight:400;line-height:1.15;">Reset your password</h1>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.7;">Hi ${safeName},</p>
            <p style="margin:0 0 22px;font-size:16px;line-height:1.7;">
              We received a request to reset the password for your platform account. Use the button below to choose a new password.
            </p>
            <a
              href="${safeUrl}"
              style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:14px;font-size:15px;font-weight:600;"
            >
              Reset Password
            </a>
            <p style="margin:22px 0 0;font-size:14px;line-height:1.7;color:rgba(24,20,20,0.72);">
              This link expires in ${safeExpiry}. If you did not request this, you can safely ignore this email.
            </p>
            <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:rgba(24,20,20,0.52);word-break:break-all;">
              ${safeUrl}
            </p>
          </div>
        </div>
      `
    });
  } catch (error) {
    throw new HttpError(
      500,
      error instanceof Error
        ? `Failed to send password reset email: ${error.message}`
        : "Failed to send password reset email."
    );
  }
}

export async function sendWorkspaceInvitationEmail(input: WorkspaceInvitationEmailInput) {
  const env = getEnv();
  const transporter = await getTransporter();
  const fromAddress = env.SMTP_FROM || env.SMTP_USER;
  const safeWorkspaceName = escapeHtml(input.workspaceName.trim() || "your workspace");
  const safeInviteUrl = escapeHtml(input.inviteUrl);
  const safeRole = escapeHtml(input.role);
  const safeInviter = escapeHtml(input.inviterName?.trim() || "AeroConcierge Team");
  const expiryLabel = new Date(input.expiresAt).toLocaleString();

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: input.to,
      subject: `You're invited to join ${input.workspaceName}`,
      text: [
        `Hello,`,
        "",
        `${input.inviterName?.trim() || "A teammate"} invited you to join ${input.workspaceName}.`,
        `Role: ${input.role}`,
        `Accept invitation: ${input.inviteUrl}`,
        `Expires: ${expiryLabel}`
      ].join("\n"),
      html: `
        <div style="background:#f6f1e7;padding:32px 18px;font-family:Georgia,'Times New Roman',serif;color:#181414;">
          <div style="max-width:560px;margin:0 auto;background:#fffaf3;border:1px solid rgba(24,20,20,0.08);border-radius:24px;padding:32px;">
            <p style="margin:0 0 10px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#8c6a32;">AeroConcierge</p>
            <h1 style="margin:0 0 16px;font-size:32px;font-weight:400;line-height:1.15;">Workspace Invitation</h1>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.7;">${safeInviter} invited you to join <strong>${safeWorkspaceName}</strong>.</p>
            <p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:rgba(24,20,20,0.72);">Role: ${safeRole}</p>
            <a
              href="${safeInviteUrl}"
              style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:14px;font-size:15px;font-weight:600;"
            >
              Accept Invitation
            </a>
            <p style="margin:22px 0 0;font-size:14px;line-height:1.7;color:rgba(24,20,20,0.72);">
              This invitation expires on ${escapeHtml(expiryLabel)}.
            </p>
            <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:rgba(24,20,20,0.52);word-break:break-all;">
              ${safeInviteUrl}
            </p>
          </div>
        </div>
      `
    });
  } catch (error) {
    throw new HttpError(
      500,
      error instanceof Error
        ? `Failed to send workspace invitation email: ${error.message}`
        : "Failed to send workspace invitation email."
    );
  }
}
