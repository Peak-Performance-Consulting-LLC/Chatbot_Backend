import { NextResponse, type NextRequest } from "next/server";
import { buildPlatformOauthReturnUrl, exchangePlatformOauthCode, assertPlatformOauthProvider } from "@/platform/oauth";
import { loginPlatformUserWithOAuth } from "@/platform/service";
import { toHttpError } from "@/lib/httpError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "platform_oauth_state";

function buildExpiredCookiePath(provider: string) {
  return `/api/platform/oauth/${provider}/callback`;
}

function clearOauthStateCookie(response: NextResponse, provider: string, secure: boolean) {
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: buildExpiredCookiePath(provider),
    expires: new Date(0)
  });
}

function buildRedirectResponse(url: string, provider: string, secure: boolean) {
  const response = NextResponse.redirect(url);
  clearOauthStateCookie(response, provider, secure);
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerParam } = await context.params;
  const provider = assertPlatformOauthProvider(providerParam);
  const secure = request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const providerError =
    request.nextUrl.searchParams.get("error_description") ||
    request.nextUrl.searchParams.get("error") ||
    "";

  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  if (!state || !expectedState || state !== expectedState) {
    return buildRedirectResponse(
      buildPlatformOauthReturnUrl({ error: "OAuth session expired. Start the sign-in flow again." }),
      provider,
      secure
    );
  }

  if (providerError) {
    return buildRedirectResponse(buildPlatformOauthReturnUrl({ error: providerError }), provider, secure);
  }

  try {
    const profile = await exchangePlatformOauthCode(provider, code);
    const result = await loginPlatformUserWithOAuth(profile);
    return buildRedirectResponse(buildPlatformOauthReturnUrl({ token: result.token }), provider, secure);
  } catch (error) {
    const asHttpError = toHttpError(error);
    return buildRedirectResponse(buildPlatformOauthReturnUrl({ error: asHttpError.message }), provider, secure);
  }
}
