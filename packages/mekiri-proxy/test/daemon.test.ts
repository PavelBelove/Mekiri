import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
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
        rule: { id: "rule-cut-1", matchQuote: "old reply text" },
      }
    );
    expect(registerResult.status).toBe(200);
    expect(registerResult.body).toEqual({ status: "ok" });

    const requestBody = {
      messages: [
        { role: "user", content: "old turn" },
        { role: "assistant", content: [{ type: "text", text: "old reply text" }] },
        { role: "user", content: "middle turn" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "prune", input: { quote: "old reply text" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: JSON.stringify({ status: "ok", rule_id: "rule-cut-1" }) }],
            },
          ],
        },
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
      requestBody.messages[0],
      requestBody.messages[3],
      requestBody.messages[4],
      requestBody.messages[5],
    ]);
  });

  it("accumulates rules registered across multiple /control/rule calls instead of overwriting them", async () => {
    const sessionId = "accumulate-session";
    await jsonRequest(
      DAEMON_PORT,
      { path: "/control/rule", method: "POST", headers: { "content-type": "application/json" } },
      { sessionId, dir: "/some/project", rule: { id: "rule-a", matchQuote: "quoteA" } }
    );
    await jsonRequest(
      DAEMON_PORT,
      { path: "/control/rule", method: "POST", headers: { "content-type": "application/json" } },
      { sessionId, dir: "/some/project", rule: { id: "rule-b", matchQuote: "quoteB" } }
    );

    const requestBody = {
      messages: [
        { role: "user", content: "turn0" },
        { role: "assistant", content: [{ type: "text", text: "quoteA" }] },
        { role: "user", content: "turn2" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "prune", input: { quote: "quoteA" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: JSON.stringify({ rule_id: "rule-a" }) }] },
          ],
        },
        { role: "user", content: "turn5" },
        { role: "assistant", content: [{ type: "text", text: "quoteB" }] },
        { role: "user", content: "turn7" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_b", name: "prune", input: { quote: "quoteB" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_b", content: [{ type: "text", text: JSON.stringify({ rule_id: "rule-b" }) }] },
          ],
        },
        { role: "user", content: "turn10" },
      ],
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    };
    await jsonRequest(
      DAEMON_PORT,
      { path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
      requestBody
    );

    expect(lastUpstreamBody.messages).toEqual([
      requestBody.messages[0],
      requestBody.messages[3],
      requestBody.messages[4],
      requestBody.messages[5],
      requestBody.messages[8],
      requestBody.messages[9],
      requestBody.messages[10],
    ]);
  });

  it("survives a client aborting mid-request instead of crashing the daemon", async () => {
    // A client disconnecting mid-body (Claude Code cancelling a request,
    // network hiccup, etc.) rejects the in-flight readBody() promise. The
    // request handler is passed straight to http.createServer, which does
    // not await it -- an uncaught rejection there is an unhandled promise
    // rejection, which terminates the real (non-test) process by default
    // and would take every session sharing this daemon down with it.
    // vitest installs its own process-level unhandledRejection listener
    // that keeps the test runner itself alive either way, so surviving
    // in-process isn't a real assertion here -- what we can check directly
    // is whether the rejection escapes at all.
    let unhandled: unknown;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(DAEMON_PORT, "127.0.0.1", () => {
          sock.write(
            "POST /v1/messages HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Content-Type: application/json\r\n" +
              "Content-Length: 10000\r\n" + // promise more body bytes than we ever send
              "\r\n" +
              "{\"messages\":"
          );
          setTimeout(() => {
            sock.destroy();
            resolve();
          }, 100);
        });
        sock.on("error", reject);
      });
      // Give the daemon's rejected promise a tick to (not) surface.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandled).toBeUndefined();

    const { status, body } = await jsonRequest(DAEMON_PORT, { path: "/health", method: "GET" });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", service: "mekiri-proxy-daemon" });
  });
});
