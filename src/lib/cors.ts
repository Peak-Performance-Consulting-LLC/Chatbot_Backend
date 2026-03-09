import { getEnv } from "@/config/env";

function normalizeOrigin(input: string): string {
  return input.replace(/\/$/, "");
}

export function getBaseCorsHeaders(request: Request) {
  const env = getEnv();
  const requestOrigin = request.headers.get("origin") || "";
  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);

  let allowOrigin = "*";
  if (env.CORS_STRICT && normalizedRequestOrigin) {
    allowOrigin = env.allowedOrigins.includes(normalizedRequestOrigin)
      ? normalizedRequestOrigin
      : env.allowedOrigins[0] || "";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, Authorization, X-Request-Id",
    "Access-Control-Max-Age": "86400"
  };
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
      ...getBaseCorsHeaders(request)
    }
  });
}
