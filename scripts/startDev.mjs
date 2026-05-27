import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { startSocketServer } from "./socketServer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const nextDir = resolve(projectRoot, ".next");
const serverDir = resolve(nextDir, "server");
const middlewareManifestPath = resolve(serverDir, "middleware-manifest.json");

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

await startSocketServer({
  projectRoot,
  dev: true,
  hostname: process.env.HOST || "localhost",
  port: Number(process.env.PORT || 3000)
});
