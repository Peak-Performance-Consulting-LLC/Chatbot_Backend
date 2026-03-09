import fs from "node:fs";
import path from "node:path";

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadLocalEnv() {
  const base = process.cwd();
  const candidates = [".env.local", ".env"];

  for (const filename of candidates) {
    const filePath = path.join(base, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const parsed = parseDotEnv(fs.readFileSync(filePath, "utf8"));

    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}
