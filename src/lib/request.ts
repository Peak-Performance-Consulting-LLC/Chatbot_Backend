export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id") || crypto.randomUUID();
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "0.0.0.0";
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "0.0.0.0";
}

export function getRequestHost(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host;
    } catch {
      return null;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host;
    } catch {
      return null;
    }
  }

  return request.headers.get("host");
}
