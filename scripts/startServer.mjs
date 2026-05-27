import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { startSocketServer } from "./socketServer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const dev = !process.argv.includes("--prod") && process.env.NODE_ENV !== "production";

await startSocketServer({
  projectRoot,
  dev,
  hostname: process.env.HOST || "localhost",
  port: Number(process.env.PORT || 3000)
});
