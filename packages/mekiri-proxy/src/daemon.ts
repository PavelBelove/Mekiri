import http from "node:http";
import https from "node:https";
import { rewriteMessages } from "./rewriteMessages.js";
import type { RewriteRule } from "./rewriteMessages.js";
import { extractSessionId } from "./sessionMetadata.js";
import { loadAllRules, saveRule } from "./ruleStore.js";

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
  rule: RewriteRule;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function createDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const rules = new Map<string, RewriteRule>();
  for (const [sessionId, entry] of Object.entries(await loadAllRules())) {
    rules.set(sessionId, entry.rule);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mekiri-proxy-daemon" }));
      return;
    }

    if (req.method === "POST" && req.url === "/control/rule") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8")) as ControlRuleBody;
      rules.set(body.sessionId, body.rule);
      await saveRule(body.sessionId, body.dir, body.rule);
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
        const rule = sessionId ? rules.get(sessionId) : undefined;
        if (rule) {
          parsed.messages = rewriteMessages(parsed.messages, rule);
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
  });

  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
