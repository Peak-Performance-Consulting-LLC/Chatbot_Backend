import { getEnv } from "@/config/env";

function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isPlaceholderOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "your-widget-host.vercel.app" ||
      hostname.includes("your-widget-host") ||
      hostname.includes("placeholder") ||
      hostname.endsWith(".example.com")
    );
  } catch {
    return false;
  }
}

function getTrustedCorsOrigins() {
  const env = getEnv();
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

  const candidates = [
    ...env.allowedOrigins,
    env.PLATFORM_APP_URL,
    env.WIDGET_HOST_URL
  ]
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  return Array.from(
    new Set(
      candidates.filter((origin) => {
        if (!isProduction) {
          return true;
        }

        return !isLocalOrigin(origin) && !isPlaceholderOrigin(origin);
      })
    )
  );
}

export function getBaseCorsHeaders(request: Request) {
  const env = getEnv();
  const requestOrigin = request.headers.get("origin") || "";
  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
  const shouldRestrictOrigin = env.CORS_STRICT || isProduction;
  const trustedOrigins = getTrustedCorsOrigins();

  let allowOrigin = "";
  if (shouldRestrictOrigin && normalizedRequestOrigin) {
    allowOrigin = trustedOrigins.length === 0
      ? normalizedRequestOrigin
      : trustedOrigins.includes(normalizedRequestOrigin)
        ? normalizedRequestOrigin
        : "";
  } else if (shouldRestrictOrigin) {
    allowOrigin = trustedOrigins[0] || requestOrigin || "";
  } else {
    allowOrigin = normalizedRequestOrigin || "*";
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, Authorization, X-Request-Id, X-Tenant-Site-Host",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

export function optionsCorsResponse(request: Request) {
  return new Response(null, {
    status: 204,
    headers: getBaseCorsHeaders(request)
  });
}

export function jsonCorsResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      ...getBaseCorsHeaders(request)
    }
  });
}
