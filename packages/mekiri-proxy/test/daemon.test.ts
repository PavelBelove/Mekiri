import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemon } from "../src/daemon.js";

function jsonRequest(port: number, options: http.RequestOptions, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("daemon", () => {
  let stateDir: string;
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let lastUpstreamBody: any;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  const DAEMON_PORT = 18791;

  beforeAll(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-daemon-test-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;

    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: true }));
      });
    });
    await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
    mockUpstreamPort = (mockUpstream.address() as any).port;

    daemon = await createDaemon({
      port: DAEMON_PORT,
      upstream: { protocol: "http", host: "127.0.0.1", port: mockUpstreamPort },
    });
  });

  afterAll(async () => {
    await daemon.close();
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("responds to /health", async () => {
    const { status, body } = await jsonRequest(DAEMON_PORT, { path: "/health", method: "GET" });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", service: "mekiri-proxy-daemon" });
  });

  it("relays a request unchanged when no rule is registered for its session", async () => {
    const requestBody = {
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: JSON.stringify({ session_id: "no-rule-session" }) },
    };
    const { status, body } = await jsonRequest(
      DAEMON_PORT,
      { path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
      requestBody
    );
    expect(status).toBe(200);
    expect(body).toEqual({ echoed: true });
    expect(lastUpstreamBody.messages).toEqual(requestBody.messages);
  });

  it("registers a rule via /control/rule and applies it to the next relayed request for that session", async () => {
    const registerResult = await jsonRequest(
      DAEMON_PORT,
      { path: "/control/rule", method: "POST", headers: { "content-type": "application/json" } },
      {
        sessionId: "cut-session",
        dir: "/some/project",
        rule: { matchQuote: "old reply text", replacement: [{ role: "user", content: "[distillate]" }] },
      }
    );
    expect(registerResult.status).toBe(200);
    expect(registerResult.body).toEqual({ status: "ok" });

    const requestBody = {
      messages: [
        { role: "user", content: "old turn" },
        { role: "assistant", content: [{ type: "text", text: "old reply text" }] },
        { role: "user", content: "new turn" },
      ],
      metadata: { user_id: JSON.stringify({ session_id: "cut-session" }) },
    };
    await jsonRequest(
      DAEMON_PORT,
      { path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
      requestBody
    );

    expect(lastUpstreamBody.messages).toEqual([
      { role: "user", content: "[distillate]" },
      { role: "user", content: "new turn" },
    ]);
  });
});
