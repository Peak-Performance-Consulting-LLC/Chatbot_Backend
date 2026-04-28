import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function buildCorsHeaders(request: NextRequest) {
  const origin = request.headers.get("origin")?.trim() || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Requested-With, Authorization, X-Request-Id, X-Tenant-Site-Host",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

export function middleware(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const corsHeaders = buildCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  matcher: ["/api/:path*"]
};
