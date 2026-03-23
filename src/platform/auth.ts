import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { HttpError } from "@/lib/httpError";

const PASSWORD_KEYLEN = 64;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashOpaqueToken(token: string): string {
  return sha256(token);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, PASSWORD_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, encoded] = storedHash.split(":");
  if (!salt || !encoded) {
    return false;
  }

  const derived = scryptSync(password, salt, PASSWORD_KEYLEN);
  const reference = Buffer.from(encoded, "hex");

  if (reference.length !== derived.length) {
    return false;
  }

  return timingSafeEqual(reference, derived);
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashOpaqueToken(token)
  };
}

export function createPasswordResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashOpaqueToken(token)
  };
}

export function parseBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/);

  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "Missing Bearer token");
  }

  return token.trim();
}

export function hashSessionToken(token: string): string {
  return hashOpaqueToken(token);
}
