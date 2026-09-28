import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "mekiri-core";
import { computeExcluded, rewriteMessages } from "./rewriteMessages.js";
import type { SessionRule } from "./rewriteMessages.js";
import { createResetRule, estimateTokens, isResetRule, resolveThreshold } from "./contextReset.js";
import { extractSessionId } from "./sessionMetadata.js";
import { loadAllRules, appendRule, setSessionDir } from "./ruleStore.js";
import { appendNewShadowMessages } from "./shadowTranscript.js";
import { logNewPrompts } from "./promptLog.js";

export interface DaemonOptions {
  port: number;
  upstream: { protocol: "http" | "https"; host: string; port: number };
}

export interface DaemonHandle {
  server: http.Server;
  close: () => Promise<void>;
}

interface ControlRuleBody {
  sessionId: string;
  dir: string;
  rule: SessionRule;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function createDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const rules = new Map<string, SessionRule[]>();
  // Project directory per session (filled by the MCP server's first prune):
  // where the reset reads config and writes its [auto-reset] record.
  const dirs = new Map<string, string>();
  for (const [sessionId, entry] of Object.entries(await loadAllRules())) {
    rules.set(sessionId, entry.rules);
    if (entry.dir) dirs.set(sessionId, entry.dir);
  }

  // Resets only the main thread (side requests share the session id), and
  // only when the outgoing request -- after existing rules -- is over the
  // threshold: the previous response's usage can lag a whole huge read.
  async function maybeReset(
    sessionId: string,
    parsed: { messages: unknown[]; [key: string]: unknown },
    anthropicBeta: string | string[] | undefined,
  ): Promise<void> {
    const dir = dirs.get(sessionId);
    if (!dir) return;
    const { contextReset } = await loadConfig(dir);
    if (!contextReset.enabled) return;
    const sessionRules = rules.get(sessionId) ?? [];
    const outgoing = sessionRules.length > 0 ? rewriteMessages(parsed.messages, sessionRules) : parsed.messages;
    const estimate = estimateTokens({ system: parsed.system, tools: parsed.tools, messages: outgoing });
    if (estimate < resolveThreshold(contextReset.thresholdTokens, anthropicBeta)) return;
    const rule = await createResetRule({
      sessionId,
      dir,
      messages: parsed.messages,
      excluded: computeExcluded(parsed.messages, sessionRules),
      resetRules: sessionRules.filter(isResetRule),
      settings: contextReset,
      estimate,
    });
    if (!rule) return;
    rules.set(sessionId, [...sessionRules, rule]);
    await appendRule(sessionId, dir, rule);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ status: "ok", service: "mekiri-proxy-daemon", pid: process.pid, sourceDir })
        );
        return;
      }

      if (req.method === "POST" && req.url === "/control/session") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { sessionId: string; dir: string };
        dirs.set(body.sessionId, body.dir);
        await setSessionDir(body.sessionId, body.dir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "POST" && req.url === "/control/rule") {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString("utf8")) as ControlRuleBody;
        const existing = rules.get(body.sessionId) ?? [];
        rules.set(body.sessionId, [...existing, body.rule]);
        if (body.dir) dirs.set(body.sessionId, body.dir);
        await appendRule(body.sessionId, body.dir, body.rule);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      let bodyBuf = await readBody(req);
      const headers = { ...req.headers, host: options.upstream.host };

      if (req.url?.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
        try {
          const parsed = JSON.parse(bodyBuf.toString("utf8"));
          const sessionId = extractSessionId(parsed);
          // Archive the full, uncut wire-level history before rewriteMessages
          // mutates parsed.messages in place -- this is the durable source
          // graft reads from, independent of Claude Code's own mutable .jsonl
          // file (see shadowTranscript.ts). Archival failing must never break
          // the actual proxy request.
          if (sessionId) {
            const mainThread = await appendNewShadowMessages(sessionId, parsed.messages).catch(() => false);
            // After the shadow append: a first-seen session backfills its
            // prompt log from the shadow archive (see promptLog.ts). Side
            // requests sharing the session id carry no user prompts.
            if (mainThread) await logNewPrompts(sessionId, parsed.messages).catch(() => {});
            // A failed reset leaves the request as it was: Claude Code's own
            // auto-compaction remains the insurance.
            if (mainThread) await maybeReset(sessionId, parsed, req.headers["anthropic-beta"]).catch(() => {});
          }
          const sessionRules = sessionId ? rules.get(sessionId) : undefined;
          if (sessionRules && sessionRules.length > 0) {
            parsed.messages = rewriteMessages(parsed.messages, sessionRules);
            bodyBuf = Buffer.from(JSON.stringify(parsed), "utf8");
          }
        } catch {
          // Malformed body -- forward unchanged rather than fail the request.
        }
      }
      // The body is always fully buffered above before forwarding, so any
      // transfer-encoding: chunked framing from the original client no longer
      // applies. Leaving it in place alongside a freshly computed
      // content-length produces an ambiguous request that Node's upstream
      // HTTP parser rejects outright (smuggling protection) with a 400 --
      // strip it so only content-length describes the forwarded body.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(Buffer.byteLength(bodyBuf));

      const transport = options.upstream.protocol === "https" ? https : http;
      const proxyReq = transport.request(
        { hostname: options.upstream.host, port: options.upstream.port, path: req.url, method: req.method, headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream error", message: err.message }));
      });
      proxyReq.end(bodyBuf);
    } catch (err) {
      // Anything above can throw asynchronously -- most commonly the client
      // aborting mid-request, which rejects readBody()'s promise. This
      // handler is passed straight to http.createServer, which does not
      // await it, so an uncaught rejection here would otherwise become an
      // unhandled promise rejection: Node terminates the whole process on
      // that by default, killing the daemon (and every other session
      // sharing it) for every subsequent request until it's restarted.
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "proxy error", message: err instanceof Error ? err.message : String(err) }));
        } catch {
          // Client's socket is already gone -- nothing left to respond to.
        }
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
