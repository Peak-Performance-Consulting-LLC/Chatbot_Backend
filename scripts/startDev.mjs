import { mkdirSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const nextDir = resolve(projectRoot, ".next");
const serverDir = resolve(nextDir, "server");
const middlewareManifestPath = resolve(serverDir, "middleware-manifest.json");
const nextCliPath = resolve(projectRoot, "node_modules", "next", "dist", "bin", "next");

rmSync(nextDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });
writeFileSync(
  middlewareManifestPath,
  JSON.stringify(
    {
      version: 3,
      middleware: {},
      functions: {},
      sortedMiddleware: []
    },
    null,
    2
  )
);

const child = spawn(process.execPath, [nextCliPath, "dev", "-p", "3000"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
