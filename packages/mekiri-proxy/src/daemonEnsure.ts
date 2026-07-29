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

  const child = spawn(options.spawnCommand, options.spawnArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await checkHealth(options.port)) return;
  }
  throw new Error(`mekiri-proxy daemon did not become healthy on port ${options.port} within timeout`);
}
