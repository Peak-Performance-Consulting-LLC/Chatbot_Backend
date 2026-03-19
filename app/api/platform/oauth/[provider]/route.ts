import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  assertPlatformOauthProvider,
  createPlatformOauthAuthorizationUrl,
  resolvePlatformOauthAppUrl
} from "@/platform/oauth";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "platform_oauth_state";
const OAUTH_APP_URL_COOKIE = "platform_oauth_app_url";

function buildCookieSecurity(request: NextRequest) {
  return request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
}

function buildCallbackCookiePath(provider: string) {
  return `/api/platform/oauth/${provider}/callback`;
}

function resolveRequestedAppUrl(request: NextRequest): string | null {
  return (
    resolvePlatformOauthAppUrl(request.nextUrl.searchParams.get("app_url")) ??
    resolvePlatformOauthAppUrl(request.headers.get("referer"))
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider: providerParam } = await context.params;
    const provider = assertPlatformOauthProvider(providerParam);
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = createPlatformOauthAuthorizationUrl(provider, state);
    const response = NextResponse.redirect(authorizationUrl);
    const appUrl = resolveRequestedAppUrl(request);
    const cookiePath = buildCallbackCookiePath(provider);

    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: "lax",
      secure: buildCookieSecurity(request),
      path: cookiePath,
      maxAge: 10 * 60
    });

    if (appUrl) {
      response.cookies.set({
        name: OAUTH_APP_URL_COOKIE,
        value: appUrl,
        httpOnly: true,
        sameSite: "lax",
        secure: buildCookieSecurity(request),
        path: cookiePath,
        maxAge: 10 * 60
      });
    }

    return response;
  } catch (error) {
    const asHttpError = toHttpError(error);
    return NextResponse.json({ error: asHttpError.message }, { status: asHttpError.status });
  }
}
