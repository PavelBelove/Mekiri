import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDaemon } from "../src/daemonEnsure.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "fake-daemon.mjs");

function isHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

describe("ensureDaemon", () => {
  let manuallyStarted: http.Server | undefined;

  afterEach(async () => {
    if (manuallyStarted) {
      await new Promise<void>((resolve) => manuallyStarted!.close(() => resolve()));
      manuallyStarted = undefined;
    }
  });

  it("spawns the daemon when nothing is listening on the port", async () => {
    const port = 18901;
    expect(await isHealthy(port)).toBe(false);

    await ensureDaemon({ port, spawnCommand: process.execPath, spawnArgs: [FIXTURE, String(port)] });

    expect(await isHealthy(port)).toBe(true);
  }, 10000);

  it("does not spawn a new process when the daemon is already healthy", async () => {
    const port = 18902;
    manuallyStarted = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "mekiri-proxy-daemon" }));
      }
    });
    await new Promise<void>((resolve) => manuallyStarted!.listen(port, "127.0.0.1", resolve));

    // spawnCommand deliberately points at a command that would fail loudly if invoked,
    // proving ensureDaemon short-circuited on the existing health check.
    await ensureDaemon({ port, spawnCommand: "false", spawnArgs: [] });

    expect(await isHealthy(port)).toBe(true);
  });
});
