import { getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";

export type PlatformOauthProvider = "google" | "facebook";

export type PlatformOauthProfile = {
  provider: PlatformOauthProvider;
  provider_user_id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
};

type OAuthErrorPayload = {
  error?: string | { message?: string };
  error_description?: string;
  message?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function normalizeHttpOrigin(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return trimTrailingSlash(url.origin);
  } catch {
    return null;
  }
}

function getBackendPublicUrl(): string {
  const env = getEnv();
  return trimTrailingSlash(env.BACKEND_PUBLIC_URL || "http://localhost:3000");
}

function getPlatformAppUrl(): string {
  const env = getEnv();
  return trimTrailingSlash(env.PLATFORM_APP_URL || env.WIDGET_HOST_URL || "http://localhost:5173");
}

function getAllowedPlatformAppOrigins(): Set<string> {
  const env = getEnv();
  return new Set(
    [env.PLATFORM_APP_URL, env.WIDGET_HOST_URL, env.BACKEND_PUBLIC_URL, ...env.allowedOrigins]
      .map((value) => normalizeHttpOrigin(value))
      .filter((value): value is string => Boolean(value))
  );
}

function getRedirectUri(provider: PlatformOauthProvider): string {
  return `${getBackendPublicUrl()}/api/platform/oauth/${provider}/callback`;
}

function normalizeName(input: string | null | undefined, fallbackEmail: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed.slice(0, 120);
  }

  const fallback = fallbackEmail.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return fallback ? fallback.slice(0, 120) : "Platform User";
}

function normalizeAvatarUrl(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

async function readOauthError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as OAuthErrorPayload;
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
    if (payload.error && typeof payload.error === "object" && payload.error.message?.trim()) {
      return payload.error.message.trim();
    }
    if (payload.error_description?.trim()) {
      return payload.error_description.trim();
    }
    if (payload.message?.trim()) {
      return payload.message.trim();
    }
  } catch {
    // ignore JSON parse failures and fall through to generic error text
  }

  return `HTTP ${response.status}`;
}

export function assertPlatformOauthProvider(value: string): PlatformOauthProvider {
  if (value === "google" || value === "facebook") {
    return value;
  }
  throw new HttpError(404, "OAuth provider not supported");
}

export function resolvePlatformOauthAppUrl(input?: string | null): string | null {
  const candidate = normalizeHttpOrigin(input);
  if (!candidate) {
    return null;
  }

  return getAllowedPlatformAppOrigins().has(candidate) ? candidate : null;
}

export function createPlatformOauthAuthorizationUrl(provider: PlatformOauthProvider, state: string): string {
  const env = getEnv();
  const redirectUri = getRedirectUri(provider);

  if (provider === "google") {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new HttpError(500, "Google OAuth is not configured");
    }

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      state
    }).toString();
    return url.toString();
  }

  if (!env.FACEBOOK_OAUTH_APP_ID || !env.FACEBOOK_OAUTH_APP_SECRET) {
    throw new HttpError(500, "Facebook OAuth is not configured");
  }

  const url = new URL("https://www.facebook.com/dialog/oauth");
  url.search = new URLSearchParams({
    client_id: env.FACEBOOK_OAUTH_APP_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "email,public_profile",
    state
  }).toString();
  return url.toString();
}

async function exchangeGoogleCode(code: string): Promise<PlatformOauthProfile> {
  const env = getEnv();
  const redirectUri = getRedirectUri("google");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }),
    cache: "no-store"
  });

  if (!tokenResponse.ok) {
    throw new HttpError(502, `Google token exchange failed: ${await readOauthError(tokenResponse)}`);
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new HttpError(502, "Google token exchange did not return an access token");
  }

  const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`
    },
    cache: "no-store"
  });

  if (!userInfoResponse.ok) {
    throw new HttpError(502, `Google profile lookup failed: ${await readOauthError(userInfoResponse)}`);
  }

  const profile = (await userInfoResponse.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new HttpError(400, "Google did not return a verified email address");
  }

  const email = profile.email.trim().toLowerCase();
  return {
    provider: "google",
    provider_user_id: profile.sub,
    email,
    full_name: normalizeName(profile.name, email),
    avatar_url: normalizeAvatarUrl(profile.picture)
  };
}

async function exchangeFacebookCode(code: string): Promise<PlatformOauthProfile> {
  const env = getEnv();
  const redirectUri = getRedirectUri("facebook");
  const tokenUrl = new URL("https://graph.facebook.com/oauth/access_token");
  tokenUrl.search = new URLSearchParams({
    client_id: env.FACEBOOK_OAUTH_APP_ID,
    client_secret: env.FACEBOOK_OAUTH_APP_SECRET,
    redirect_uri: redirectUri,
    code
  }).toString();

  const tokenResponse = await fetch(tokenUrl, {
    cache: "no-store"
  });

  if (!tokenResponse.ok) {
    throw new HttpError(502, `Facebook token exchange failed: ${await readOauthError(tokenResponse)}`);
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new HttpError(502, "Facebook token exchange did not return an access token");
  }

  const userUrl = new URL("https://graph.facebook.com/me");
  userUrl.search = new URLSearchParams({
    fields: "id,name,email,picture.type(large)",
    access_token: tokenPayload.access_token
  }).toString();

  const userResponse = await fetch(userUrl, {
    cache: "no-store"
  });

  if (!userResponse.ok) {
    throw new HttpError(502, `Facebook profile lookup failed: ${await readOauthError(userResponse)}`);
  }

  const profile = (await userResponse.json()) as {
    id?: string;
    name?: string;
    email?: string;
    picture?: {
      data?: {
        url?: string;
      };
    };
  };

  if (!profile.id || !profile.email) {
    throw new HttpError(400, "Facebook did not return an email address for this account");
  }

  const email = profile.email.trim().toLowerCase();
  return {
    provider: "facebook",
    provider_user_id: profile.id,
    email,
    full_name: normalizeName(profile.name, email),
    avatar_url: normalizeAvatarUrl(profile.picture?.data?.url)
  };
}

export async function exchangePlatformOauthCode(
  provider: PlatformOauthProvider,
  code: string
): Promise<PlatformOauthProfile> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new HttpError(400, "OAuth code is required");
  }

  return provider === "google" ? exchangeGoogleCode(trimmedCode) : exchangeFacebookCode(trimmedCode);
}

export function buildPlatformOauthReturnUrl(input: { token?: string; error?: string; appUrl?: string | null }): string {
  const appUrl = resolvePlatformOauthAppUrl(input.appUrl) ?? getPlatformAppUrl();
  const url = new URL("/platform/login", appUrl);

  if (input.token) {
    url.searchParams.set("oauth_token", input.token);
  }

  if (input.error) {
    url.searchParams.set("oauth_error", input.error);
  }

  return url.toString();
}
