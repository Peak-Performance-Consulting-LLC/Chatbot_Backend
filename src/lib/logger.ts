function log(level: "info" | "error", event: string, payload?: Record<string, unknown>) {
  const line = {
    level,
    event,
    ts: new Date().toISOString(),
    ...(payload ?? {})
  };

  if (level === "error") {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export function logInfo(event: string, payload?: Record<string, unknown>) {
  log("info", event, payload);
}

export function logError(event: string, payload?: Record<string, unknown>) {
  log("error", event, payload);
}
