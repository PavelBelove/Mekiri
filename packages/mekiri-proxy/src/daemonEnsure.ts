import { spawn } from "node:child_process";
import http from "node:http";

export interface EnsureDaemonOptions {
  port: number;
  spawnCommand: string;
  spawnArgs: string[];
}

function checkHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(body.service === "mekiri-proxy-daemon");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<void> {
  if (await checkHealth(options.port)) return;

  let spawnError: Error | undefined;
  const child = spawn(options.spawnCommand, options.spawnArgs, {
    detached: true,
    stdio: "ignore",
  });
  // Without this listener, a spawn failure (e.g. ENOENT for a nonexistent
  // binary) surfaces as an uncaught 'error' event and crashes the whole
  // process instead of failing this one operation.
  child.on("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });
  child.unref();

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await checkHealth(options.port)) return;
    if (spawnError) {
      throw new Error(
        `mekiri-proxy daemon failed to spawn on port ${options.port}: ${spawnError.message}`
      );
    }
  }
  throw new Error(`mekiri-proxy daemon did not become healthy on port ${options.port} within timeout`);
}
