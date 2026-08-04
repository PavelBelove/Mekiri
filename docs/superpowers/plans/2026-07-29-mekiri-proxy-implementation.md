# mekiri-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/mekiri-proxy` — a daemon + MCP server that gives any existing Claude Code session real `prune`/`sprout`/`configure_mekiri` by rewriting `messages[]` on the wire (via `ANTHROPIC_BASE_URL`) before it reaches `api.anthropic.com`, without touching the local session transcript or the user's UI.

**Architecture:** A long-lived HTTP daemon relays every request to the real Anthropic API, optionally rewriting `messages[]` per-session (looked up via `metadata.user_id.session_id` in the request body) according to a persisted rule. A stdio MCP server, spawned per Claude Code session via `.mcp.json`, exposes `prune`/`sprout`/`configure_mekiri` to the model; it idempotently ensures the daemon is running, resolves quotes to cut boundaries using `mekiri-core`, and registers rules with the daemon over a local control API. `sprout` spawns a real `claude --fork-session` child process pointed at the same daemon and `.mcp.json`, so clones inherit the same tools recursively.

**Task ordering priority (owner's explicit instruction, 2026-07-29):** get `prune` working end-to-end in the owner's own user-facing session first — that is the primary value. `sprout` is deferred to its own later task (Task 11) built on top of an already-proven `prune`, not developed in lockstep with it. Tasks 1-9 produce a fully working `prune`/`configure_mekiri` MCP server with no `sprout` dependency at all; Task 10 (`spawnClone`) and Task 11 (wiring `sprout` into the MCP server) come after.

**Tech Stack:** TypeScript (ESM, NodeNext), Node.js built-ins (`http`/`https`/`child_process`/`fs`), `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`), `zod`, `mekiri-core` (workspace dependency), `vitest`, `tsx` (dev-run without a build step, matching `mekiri-host`'s existing convention).

## Global Constraints

- Package lives at `packages/mekiri-proxy`, added to the existing npm workspace (`package.json`'s `"workspaces": ["packages/*"]` already covers it — no root config change needed).
- `tsconfig.json` extends `../../tsconfig.base.json` exactly like `mekiri-core`/`mekiri-host` (`target: ES2022`, `module`/`moduleResolution: NodeNext`, `strict: true`).
- All imports use explicit `.js` extensions (NodeNext ESM convention already used throughout `mekiri-core`).
- Tool signatures (`prune`/`sprout`/`configure_mekiri` args and return shapes) match `docs/superpowers/specs/2026-07-29-mekiri-proxy-design.md` §3 exactly.
- Main test suite must run with **zero** real network calls and **zero** Anthropic API key — only Task 12's smoke test touches the real API, and it is explicitly opt-in (skipped by default).
- No dependency on `mekiri-host` — only `mekiri-core` is a workspace dependency.

---

### Task 1: Package scaffolding

**Files:**
- Create: `packages/mekiri-proxy/package.json`
- Create: `packages/mekiri-proxy/tsconfig.json`
- Create: `packages/mekiri-proxy/vitest.config.ts`
- Create: `packages/mekiri-proxy/src/index.ts`
- Test: `packages/mekiri-proxy/test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm install && npm run build && npm test` cycle for later tasks to build on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mekiri-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "mekiri-core": "*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create a placeholder `src/index.ts`**

```ts
export const PACKAGE_NAME = "mekiri-proxy";
```

- [ ] **Step 5: Write a smoke test**

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package scaffolding", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-proxy");
  });
});
```

- [ ] **Step 6: Install and verify**

Run: `cd /home/pol/dev/rollback && npm install`
Expected: workspace picks up `packages/mekiri-proxy` automatically (no root `package.json` change needed — `"workspaces": ["packages/*"]` already covers it).

Run: `cd packages/mekiri-proxy && npm test`
Expected: PASS (1 test).

Run: `npm run build`
Expected: `dist/index.js` created, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-proxy
git commit -m "chore(mekiri-proxy): scaffold new package"
```

---

### Task 2: SPIKE — verify how a transcript `messageId` maps to a position in the real `messages[]` request array

This is empirical investigation flagged as an open risk in the design spec (§4) — it must run **before** Task 4 (`rewriteMessages`) is trusted to cut at the right point when tool calls are present. It requires one short live conversation against the real Anthropic API through a throwaway inspection proxy, reusing the pattern already validated in `wire-prune-findings.md` (the owner has already given informed, explicit consent for this class of live-API experiment on this project).

**Files:**
- Create: `packages/mekiri-proxy/scratch/inspect-boundary.mjs` (throwaway investigation script, **delete in Step 5** — not part of the shipped package)
- Create: `docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md` (the durable finding this task produces)

- [ ] **Step 1: Write a throwaway inspection proxy that dumps full request bodies**

```js
// packages/mekiri-proxy/scratch/inspect-boundary.mjs
import http from "node:http";
import https from "node:https";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = 8792;
const UPSTREAM = "api.anthropic.com";
mkdirSync("./scratch/dumps", { recursive: true });
let n = 0;

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      if (req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
        n++;
        writeFileSync(`./scratch/dumps/req_${n}.json`, bodyBuf);
      }
      const headers = { ...req.headers, host: UPSTREAM };
      headers["content-length"] = Buffer.byteLength(bodyBuf);
      const proxyReq = https.request(
        { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.end(bodyBuf);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`inspect proxy on ${PORT}`));
```

- [ ] **Step 2: Run a real 3-turn conversation through it, including a tool call**

```bash
cd packages/mekiri-proxy
node scratch/inspect-boundary.mjs &
sleep 1
export ANTHROPIC_BASE_URL="http://127.0.0.1:8792"
SESSION=$(claude -p "Reply with exactly: TURN1" --output-format json | python3 -c "import json,sys;print(json.load(sys.stdin)['session_id'])")
claude --resume "$SESSION" -p "Run: echo hello (use your Bash tool)" --output-format json > /dev/null
claude --resume "$SESSION" -p "Reply with exactly: TURN3" --output-format json > /dev/null
kill %1
```

Expected: `scratch/dumps/req_1.json`, `req_2.json`, `req_3.json` exist. `req_3.json`'s `messages[]` array now contains the tool_use/tool_result pair from turn 2.

- [ ] **Step 3: Compare transcript UUIDs against `req_3.json`'s `messages[]` order**

```bash
python3 -c "
import json, glob

# Real local transcript for this session (adjust project-dir sanitization if needed)
import subprocess, os
home = os.path.expanduser('~')
sanitized = os.getcwd().replace('/', '-') if False else None
print('Inspect ~/.claude/projects/<sanitized-cwd>/ manually for the session file matching', '$SESSION' if False else '(see SESSION var above)')

d = json.load(open('scratch/dumps/req_3.json'))
for i, m in enumerate(d['messages']):
    content = m['content']
    kinds = [b.get('type') for b in content] if isinstance(content, list) else 'string'
    print(i, m['role'], kinds)
"
```

Manually open the matching `~/.claude/projects/<sanitized-cwd>/<SESSION>.jsonl` (one JSON object per line) and compare: does transcript line order (filtering to `type: "user"`/`"assistant"` lines, matching `quoteMatcher.ts`'s own filter) match `messages[]` array order **position-for-position**, including the tool_use/tool_result pair? Note whether `RawLine.uuid` values, in order, correspond 1:1 to `messages[]` array positions.

- [ ] **Step 4: Write the finding**

Write `docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md` documenting exactly what was observed — one of two outcomes:
- **Confirmed 1:1**: transcript line order (filtered to user/assistant, matching `quoteMatcher.ts`'s existing filter) equals `messages[]` array order exactly, so `keepFromIndex = (filtered transcript index of the matched UUID) + 1`. Task 4 implements this directly.
- **Not 1:1** (e.g. system-reminder injections or thinking blocks add extra array entries not present in the transcript, or vice versa): document the actual discrepancy with concrete before/after examples from the dumps, and write the correction rule Task 4 must implement instead (e.g. content-string matching against the resolved transcript line's text, walking `messages[]` to find the matching entry, rather than a raw index).

This file is a durable finding, not scratch — commit it.

- [ ] **Step 5: Delete the throwaway script and dumps, commit the finding**

```bash
rm -rf packages/mekiri-proxy/scratch
git add docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md
git commit -m "docs(mekiri-proxy): empirical finding on messageId-to-array-index mapping"
```

---

### Task 3: `sessionMetadata` + `ruleStore`

**Files:**
- Create: `packages/mekiri-proxy/src/sessionMetadata.ts`
- Create: `packages/mekiri-proxy/src/ruleStore.ts`
- Create: `packages/mekiri-proxy/src/rewriteMessages.ts` (types only in this task — `RewriteRule`; the cutting logic itself is Task 4, which depends on Task 2's finding)
- Test: `packages/mekiri-proxy/test/sessionMetadata.test.ts`
- Test: `packages/mekiri-proxy/test/ruleStore.test.ts`

**Interfaces:**
- Produces: `extractSessionId(body: unknown): string | undefined`, `RewriteRule` type, `loadAllRules(): Promise<Record<string, StoredRuleEntry>>`, `saveRule(sessionId: string, dir: string, rule: RewriteRule): Promise<void>`, `resolveStateDir(): string`.

- [ ] **Step 1: Write the failing test for `sessionMetadata`**

```ts
// packages/mekiri-proxy/test/sessionMetadata.test.ts
import { describe, it, expect } from "vitest";
import { extractSessionId } from "../src/sessionMetadata.js";

describe("extractSessionId", () => {
  it("parses session_id out of metadata.user_id", () => {
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: "abc",
          account_uuid: "def",
          session_id: "session-123",
        }),
      },
    };
    expect(extractSessionId(body)).toBe("session-123");
  });

  it("returns undefined when metadata is missing", () => {
    expect(extractSessionId({})).toBeUndefined();
  });

  it("returns undefined when user_id is not valid JSON", () => {
    expect(extractSessionId({ metadata: { user_id: "not json" } })).toBeUndefined();
  });

  it("returns undefined when session_id field is missing", () => {
    const body = { metadata: { user_id: JSON.stringify({ device_id: "abc" }) } };
    expect(extractSessionId(body)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mekiri-proxy && npx vitest run test/sessionMetadata.test.ts`
Expected: FAIL — `Cannot find module '../src/sessionMetadata.js'`

- [ ] **Step 3: Implement `sessionMetadata.ts`**

```ts
// packages/mekiri-proxy/src/sessionMetadata.ts
interface RequestMetadataShape {
  metadata?: { user_id?: string };
}

export function extractSessionId(body: unknown): string | undefined {
  const shaped = body as RequestMetadataShape;
  const raw = shaped?.metadata?.user_id;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    return typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sessionMetadata.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Define `RewriteRule` in `rewriteMessages.ts`**

```ts
// packages/mekiri-proxy/src/rewriteMessages.ts
export interface RewriteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RewriteRule {
  keepFromIndex: number;
  replacement: RewriteMessage[];
}
```

- [ ] **Step 6: Write the failing test for `ruleStore`**

```ts
// packages/mekiri-proxy/test/ruleStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("ruleStore", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-test-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty object when no rules file exists", async () => {
    const { loadAllRules } = await import("../src/ruleStore.js");
    expect(await loadAllRules()).toEqual({});
  });

  it("persists and reloads a rule keyed by sessionId", async () => {
    const { saveRule, loadAllRules } = await import("../src/ruleStore.js");
    const rule = { keepFromIndex: 2, replacement: [{ role: "user" as const, content: "note" }] };
    await saveRule("session-abc", "/some/project", rule);

    const all = await loadAllRules();
    expect(all["session-abc"].rule).toEqual(rule);
    expect(all["session-abc"].dir).toBe("/some/project");
    expect(typeof all["session-abc"].updatedAt).toBe("string");
  });

  it("preserves previously saved rules for other sessions", async () => {
    const { saveRule, loadAllRules } = await import("../src/ruleStore.js");
    await saveRule("session-a", "/proj-a", { keepFromIndex: 1, replacement: [] });
    await saveRule("session-b", "/proj-b", { keepFromIndex: 3, replacement: [] });

    const all = await loadAllRules();
    expect(Object.keys(all).sort()).toEqual(["session-a", "session-b"]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/ruleStore.test.ts`
Expected: FAIL — `Cannot find module '../src/ruleStore.js'`

- [ ] **Step 8: Implement `ruleStore.ts`**

```ts
// packages/mekiri-proxy/src/ruleStore.ts
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RewriteRule } from "./rewriteMessages.js";

export interface StoredRuleEntry {
  dir: string;
  rule: RewriteRule;
  updatedAt: string;
}

// A single, machine-global rules file — the daemon is one shared process
// serving every project on the machine (see design spec §1), so per-project
// `.mekiri/proxy-rules.json` would require resolving which project a
// sessionId belongs to before the daemon even knows where to look on
// restart. Keying everything by sessionId in one place avoids that
// resolution step entirely. Overridable for tests.
export function resolveStateDir(): string {
  return process.env.MEKIRI_PROXY_STATE_DIR || path.join(homedir(), ".mekiri-proxy");
}

function rulesFilePath(): string {
  return path.join(resolveStateDir(), "rules.json");
}

export async function loadAllRules(): Promise<Record<string, StoredRuleEntry>> {
  try {
    const raw = await fs.readFile(rulesFilePath(), "utf8");
    return JSON.parse(raw) as Record<string, StoredRuleEntry>;
  } catch {
    return {};
  }
}

export async function saveRule(sessionId: string, dir: string, rule: RewriteRule): Promise<void> {
  const all = await loadAllRules();
  all[sessionId] = { dir, rule, updatedAt: new Date().toISOString() };
  await fs.mkdir(resolveStateDir(), { recursive: true });
  await fs.writeFile(rulesFilePath(), JSON.stringify(all, null, 2), "utf8");
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/sessionMetadata.test.ts test/ruleStore.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 10: Commit**

```bash
git add packages/mekiri-proxy/src/sessionMetadata.ts packages/mekiri-proxy/src/ruleStore.ts packages/mekiri-proxy/src/rewriteMessages.ts packages/mekiri-proxy/test/sessionMetadata.test.ts packages/mekiri-proxy/test/ruleStore.test.ts
git commit -m "feat(mekiri-proxy): session_id extraction and persisted rule store"
```

---

### Task 4: `rewriteMessages` — the core cut-and-replace function

Depends on Task 2's finding — read `docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md` before writing Step 3; if it found the "not 1:1" outcome, adapt the implementation accordingly (the interface below stays the same either way — only what `keepFromIndex` means at the call site, resolved in Task 8, changes).

**Files:**
- Modify: `packages/mekiri-proxy/src/rewriteMessages.ts`
- Test: `packages/mekiri-proxy/test/rewriteMessages.test.ts`

**Interfaces:**
- Consumes: `RewriteRule` (from Task 3).
- Produces: `rewriteMessages(messages: unknown[], rule: RewriteRule | undefined): unknown[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/mekiri-proxy/test/rewriteMessages.test.ts
import { describe, it, expect } from "vitest";
import { rewriteMessages } from "../src/rewriteMessages.js";

describe("rewriteMessages", () => {
  it("returns messages unchanged when no rule is active", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(rewriteMessages(messages, undefined)).toBe(messages);
  });

  it("replaces everything before keepFromIndex with the rule's replacement", () => {
    const messages = [
      { role: "user", content: "turn1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "turn2" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "turn3" },
    ];
    const rule = {
      keepFromIndex: 4,
      replacement: [
        { role: "user" as const, content: "[MEKIRI PORTAL] cut everything before this." },
        { role: "assistant" as const, content: "distillate: turns 1-2 were about X." },
      ],
    };
    const result = rewriteMessages(messages, rule);
    expect(result).toEqual([
      { role: "user", content: "[MEKIRI PORTAL] cut everything before this." },
      { role: "assistant", content: "distillate: turns 1-2 were about X." },
      { role: "user", content: "turn3" },
    ]);
  });

  it("keeps everything when keepFromIndex is 0", () => {
    const messages = [{ role: "user", content: "turn1" }];
    const rule = { keepFromIndex: 0, replacement: [] };
    expect(rewriteMessages(messages, rule)).toEqual([{ role: "user", content: "turn1" }]);
  });

  it("does not mutate the original messages array", () => {
    const messages = [{ role: "user", content: "turn1" }, { role: "assistant", content: "reply1" }];
    const original = JSON.parse(JSON.stringify(messages));
    rewriteMessages(messages, { keepFromIndex: 1, replacement: [{ role: "user", content: "note" }] });
    expect(messages).toEqual(original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rewriteMessages.test.ts`
Expected: FAIL — `rewriteMessages is not a function`

- [ ] **Step 3: Implement `rewriteMessages`**

```ts
// append to packages/mekiri-proxy/src/rewriteMessages.ts
export function rewriteMessages(messages: unknown[], rule: RewriteRule | undefined): unknown[] {
  if (!rule) return messages;
  const kept = messages.slice(rule.keepFromIndex);
  return [...rule.replacement, ...kept];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rewriteMessages.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-proxy/src/rewriteMessages.ts packages/mekiri-proxy/test/rewriteMessages.test.ts
git commit -m "feat(mekiri-proxy): tail-cut-and-replace rewrite of messages[]"
```

---

### Task 5: `daemon` — HTTP relay with per-session rewrite and control API

**Files:**
- Create: `packages/mekiri-proxy/src/daemon.ts`
- Test: `packages/mekiri-proxy/test/daemon.test.ts`

**Interfaces:**
- Consumes: `rewriteMessages`, `extractSessionId`, `loadAllRules`/`saveRule` (Tasks 3-4).
- Produces: `createDaemon(options: DaemonOptions): Promise<DaemonHandle>` where `DaemonOptions = { port: number; upstream: { protocol: "http" | "https"; host: string; port: number } }` and `DaemonHandle = { server: http.Server; close: () => Promise<void> }`. Exposes `GET /health` and `POST /control/rule` (body `{ sessionId: string; dir: string; rule: RewriteRule }`), and relays everything else to `upstream`, rewriting `messages[]` in `POST /v1/messages` bodies when a rule is active for the request's session.

- [ ] **Step 1: Write the failing test — health check and plain relay**

```ts
// packages/mekiri-proxy/test/daemon.test.ts
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
        rule: { keepFromIndex: 1, replacement: [{ role: "user", content: "[distillate]" }] },
      }
    );
    expect(registerResult.status).toBe(200);
    expect(registerResult.body).toEqual({ status: "ok" });

    const requestBody = {
      messages: [
        { role: "user", content: "old turn" },
        { role: "assistant", content: "old reply" },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon.test.ts`
Expected: FAIL — `Cannot find module '../src/daemon.js'`

- [ ] **Step 3: Implement `daemon.ts`**

```ts
// packages/mekiri-proxy/src/daemon.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-proxy/src/daemon.ts packages/mekiri-proxy/test/daemon.test.ts
git commit -m "feat(mekiri-proxy): HTTP relay daemon with per-session rewrite and control API"
```

---

### Task 6: `daemonEnsure` — idempotent start-or-connect

**Files:**
- Create: `packages/mekiri-proxy/src/daemonEnsure.ts`
- Test: `packages/mekiri-proxy/test/daemonEnsure.test.ts`
- Create: `packages/mekiri-proxy/test/fixtures/fake-daemon.mjs` (test fixture — a trivial standalone health-server used only by the test to simulate a spawnable daemon binary)

**Interfaces:**
- Produces: `ensureDaemon(options: EnsureDaemonOptions): Promise<void>` where `EnsureDaemonOptions = { port: number; spawnCommand: string; spawnArgs: string[] }`. Resolves once `/health` on `port` responds with `{service: "mekiri-proxy-daemon"}`; spawns `spawnCommand`/`spawnArgs` detached only if it wasn't already responding.

- [ ] **Step 1: Write the test fixture — a fake daemon binary**

```js
// packages/mekiri-proxy/test/fixtures/fake-daemon.mjs
import http from "node:http";

const port = Number(process.argv[2]);
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mekiri-proxy-daemon" }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, "127.0.0.1");
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/mekiri-proxy/test/daemonEnsure.test.ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/daemonEnsure.test.ts`
Expected: FAIL — `Cannot find module '../src/daemonEnsure.js'`

- [ ] **Step 4: Implement `daemonEnsure.ts`**

```ts
// packages/mekiri-proxy/src/daemonEnsure.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/daemonEnsure.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-proxy/src/daemonEnsure.ts packages/mekiri-proxy/test/daemonEnsure.test.ts packages/mekiri-proxy/test/fixtures/fake-daemon.mjs
git commit -m "feat(mekiri-proxy): idempotent daemon start-or-connect"
```

---

### Task 7: `mekiri-core` audit schema — make `newSessionId` optional

**Files:**
- Modify: `packages/mekiri-core/src/auditLog.ts`
- Modify: `packages/mekiri-core/test/auditLog.test.ts` (exact test file name — verify with `ls packages/mekiri-core/test/` before editing; adjust path if it differs)

**Interfaces:**
- Produces: `PruneAuditEntry.newSessionId` becomes `string | undefined` instead of required `string`.

- [ ] **Step 1: Locate the existing test coverage**

Run: `grep -rn "newSessionId" packages/mekiri-core/test/`
Expected: shows the existing test(s) asserting `newSessionId` on a `PruneAuditEntry` — read the matched file before editing it.

- [ ] **Step 2: Modify the type**

In `packages/mekiri-core/src/auditLog.ts`, change:

```ts
export interface PruneAuditEntry {
  event: "prune";
  timestamp: string;
  sessionId: string;
  newSessionId: string;
```

to:

```ts
export interface PruneAuditEntry {
  event: "prune";
  timestamp: string;
  sessionId: string;
  /** Absent for prune events produced by mekiri-proxy's wire-level rewrite --
   *  that model never creates a new session, only mekiri-host's session-fork
   *  model does. */
  newSessionId?: string;
```

- [ ] **Step 3: Add a test proving an entry without `newSessionId` round-trips correctly**

Add to `packages/mekiri-core/test/auditLog.test.ts` (append near the existing prune-entry tests):

```ts
it("round-trips a prune entry with no newSessionId (wire-level prune)", async () => {
  const dir = /* reuse the same tmpdir helper the surrounding tests already use */ makeTmpProjectDir();
  await appendAuditEntry(dir, {
    event: "prune",
    timestamp: new Date().toISOString(),
    sessionId: "session-abc",
    noteType: "portal",
    removedBranchLength: 100,
    fruitLength: 20,
  });
  const entries = await readAuditLog(dir);
  expect(entries).toHaveLength(1);
  expect((entries[0] as any).newSessionId).toBeUndefined();
});
```

Adjust `makeTmpProjectDir()` to whatever helper the existing test file already uses for its tmp directories (read the file first — do not invent a new helper name that collides).

- [ ] **Step 4: Run the full mekiri-core suite**

Run: `cd packages/mekiri-core && npm test`
Expected: PASS, including the new test and all pre-existing ones (no regressions from the type change, since TypeScript structural typing accepts a missing optional field wherever a value was previously required).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/auditLog.ts packages/mekiri-core/test/auditLog.test.ts
git commit -m "feat(mekiri-core): make PruneAuditEntry.newSessionId optional for wire-level prune"
```

---

### Task 8: `mcpServer` — the stdio MCP server exposing `prune` and `configure_mekiri`

`sprout` is deliberately **not** part of this task — per the owner's priority, `prune` ships and gets dogfooded on its own first. `sprout` is added on top in Task 11, once `spawnClone` (Task 10) exists.

**Files:**
- Create: `packages/mekiri-proxy/src/mcpServer.ts`
- Create: `packages/mekiri-proxy/bin/mcp-server.ts` (real entry point, thin — wires `mcpServer.ts` to a `StdioServerTransport`)
- Create: `packages/mekiri-proxy/bin/daemon.ts` (real entry point for the daemon binary, thin — wires `daemon.ts` to real `https`/`api.anthropic.com`)
- Test: `packages/mekiri-proxy/test/mcpServer.test.ts`

**Interfaces:**
- Consumes: `rewriteMessages`/`RewriteRule` (Tasks 3-4), `mekiri-core`'s `validateFruit`/`findBoundary`/`readSessionTranscript`/`applyConfigPatch`/`saveConfig`/`appendAuditEntry`.
- Produces: `createToolHandlers(context: McpServerContext)` returning plain async functions for `prune`/`configure_mekiri` (kept separate from the MCP SDK wiring itself so they're testable without a real stdio transport), where:

```ts
export interface McpServerContext {
  sessionId: string;
  dir: string;
  depth: number;
  daemonPort: number;
  postControlRule: (body: { sessionId: string; dir: string; rule: RewriteRule }) => Promise<void>;
}
```

`depth`/`daemonPort` are already part of the context in this task even though nothing uses them yet — Task 11 adds `sprout`, which needs both, and this keeps that later change to a pure addition rather than a context-shape change every caller of `createToolHandlers` has to be touched for again.

- [ ] **Step 1: Note — `RewriteRule` already reflects Task 2's finding**

Task 2's finding (`docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md`) came back "not 1:1" (mid-conversation `role:"system"` injections and merged `thinking`+`tool_use` pairs make the local transcript diverge from the real `messages[]` array). This was discovered *after* Tasks 3-5 had already shipped a static-index design — the controller corrected that in a follow-up fix (see `git log --oneline -- packages/mekiri-proxy/src/rewriteMessages.ts`) before this task was dispatched: `RewriteRule` now carries `matchQuote: string` instead of `keepFromIndex: number`, and `rewriteMessages()` itself resolves the cut position by content-matching against whatever `messages[]` array it's actually given on each call — nothing for you to redo here. This task's `mcpServer.ts` only needs `findBoundary`/`readSessionTranscript` (from `mekiri-core`) for **upfront validation** — catching an ambiguous/not-found/in-compacted-zone quote immediately and giving the agent a useful error — not for computing any index. The registered rule simply carries the raw quote string through to the daemon.

- [ ] **Step 2: Write the failing test**

```ts
// packages/mekiri-proxy/test/mcpServer.test.ts
import { describe, it, expect, vi } from "vitest";
import { createToolHandlers } from "../src/mcpServer.js";

vi.mock("mekiri-core", async () => {
  const actual = await vi.importActual<typeof import("mekiri-core")>("mekiri-core");
  return {
    ...actual,
    readSessionTranscript: vi.fn(async () => [
      { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "the answer is 42" }] } },
    ]),
    appendAuditEntry: vi.fn(async () => {}),
  };
});

describe("prune handler", () => {
  it("registers a rule with the daemon when the quote resolves unambiguously", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({
      sessionId: "s1",
      dir: "/proj",
      depth: 0,
      daemonPort: 8791,
      postControlRule,
    });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "found the answer" },
      keep_code: false,
    });

    expect(result).toEqual({ status: "ok", cut_effective_from: "next_request" });
    expect(postControlRule).toHaveBeenCalledTimes(1);
    expect(postControlRule.mock.calls[0][0].sessionId).toBe("s1");
    expect(postControlRule.mock.calls[0][0].rule.replacement[1].content).toContain("found the answer");
  });

  it("returns invalid_fruit without calling the daemon when fruit fails validation", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 0, daemonPort: 8791, postControlRule });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: {},
      keep_code: false,
    });

    expect(result.status).toBe("invalid_fruit");
    expect(postControlRule).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/mcpServer.test.ts`
Expected: FAIL — `Cannot find module '../src/mcpServer.js'`

- [ ] **Step 4: Implement `mcpServer.ts`**

```ts
// packages/mekiri-proxy/src/mcpServer.ts
import http from "node:http";
import {
  validateFruit,
  findBoundary,
  readSessionTranscript,
  applyConfigPatch,
  saveConfig,
  appendAuditEntry,
} from "mekiri-core";
import type { NoteType, PortalFruit, DeathReloadFruit, MekiriConfig } from "mekiri-core";
import type { RewriteRule } from "./rewriteMessages.js";

export interface McpServerContext {
  sessionId: string;
  dir: string;
  depth: number;
  daemonPort: number;
  postControlRule: (body: { sessionId: string; dir: string; rule: RewriteRule }) => Promise<void>;
}

export function postControlRuleOverHttp(daemonPort: number) {
  return (body: { sessionId: string; dir: string; rule: RewriteRule }): Promise<void> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const req = http.request(
        { hostname: "127.0.0.1", port: daemonPort, path: "/control/rule", method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`daemon returned ${res.statusCode}`))));
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
}

function renderDistillate(noteType: NoteType, fruit: PortalFruit | DeathReloadFruit): string {
  if (noteType === "portal") {
    const p = fruit as PortalFruit;
    const parts = [`Дистиллят: ${p.summary}`];
    if (p.files_touched?.length) parts.push(`Изменённые файлы: ${p.files_touched.map((f) => `${f.path} (${f.change})`).join(", ")}`);
    if (p.gotchas) parts.push(`Подводные камни: ${p.gotchas}`);
    return parts.join("\n");
  }
  const d = fruit as DeathReloadFruit;
  const parts = [`Пробовал: ${d.tried}`, `Исключено: ${d.ruled_out}`];
  if (d.facts_learned) parts.push(`Факты: ${d.facts_learned}`);
  return parts.join("\n");
}

interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

type PruneResult =
  | { status: "ok"; cut_effective_from: "next_request" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "not_found" }
  | { status: "in_compacted_zone"; last_compact_message_id: string }
  | { status: "invalid_fruit"; errors: string[] };

interface ConfigureArgs {
  patch: Partial<MekiriConfig>;
  reason: string;
}

type ConfigureResult = { status: "ok" } | { status: "invalid"; errors: string[] };

export function createToolHandlers(context: McpServerContext) {
  return {
    async prune(args: PruneArgs): Promise<PruneResult> {
      const validation = validateFruit({ noteType: args.note_type, fruit: args.fruit, keepCode: args.keep_code });
      if (!validation.ok) {
        return { status: "invalid_fruit", errors: validation.errors };
      }

      const transcript = await readSessionTranscript(context.dir, context.sessionId);
      const boundary = findBoundary(transcript, args.quote);
      if (boundary.status === "not_found") return { status: "not_found" };
      if (boundary.status === "ambiguous") return { status: "ambiguous", occurrences: boundary.occurrences };
      if (boundary.status === "in_compacted_zone") {
        return { status: "in_compacted_zone", last_compact_message_id: boundary.lastCompactMessageId };
      }

      // Validation only -- findBoundary confirms the quote is unambiguous against
      // the local transcript right now, so the agent gets an immediate error on a
      // bad quote. The actual cut position is resolved later, fresh, by
      // rewriteMessages() against each real request's messages[] array (see
      // RewriteRule.matchQuote) -- not computed here, per Task 2's finding.
      const filtered = transcript.filter((l) => l.type === "user" || l.type === "assistant");
      const idx = filtered.findIndex((l) => l.uuid === boundary.messageId);

      const distillateText = renderDistillate(args.note_type, validation.fruit);
      const rule: RewriteRule = {
        matchQuote: args.quote,
        replacement: [
          { role: "user", content: "[MEKIRI PORTAL] Сверни всё до этого момента." },
          { role: "assistant", content: distillateText },
        ],
      };

      await context.postControlRule({ sessionId: context.sessionId, dir: context.dir, rule });
      await appendAuditEntry(context.dir, {
        event: "prune",
        timestamp: new Date().toISOString(),
        sessionId: context.sessionId,
        noteType: args.note_type,
        removedBranchLength: JSON.stringify(filtered.slice(idx + 1)).length,
        fruitLength: distillateText.length,
      });

      return { status: "ok", cut_effective_from: "next_request" };
    },

    async configure_mekiri(args: ConfigureArgs): Promise<ConfigureResult> {
      const result = await applyConfigPatch(context.dir, args.patch);
      if (!result.ok) return { status: "invalid", errors: result.errors };
      await saveConfig(context.dir, result.config);
      await appendAuditEntry(context.dir, {
        event: "configure_mekiri",
        timestamp: new Date().toISOString(),
        reason: args.reason,
        patch: args.patch,
      });
      return { status: "ok" };
    },
  };
}
```

Before finishing this step, run `grep -n "applyConfigPatch" packages/mekiri-core/src/configStore.ts` and confirm the real return shape of `ConfigPatchResult` (used above as `{ok, config}` / `{ok, errors}`) — adjust the `configure_mekiri` handler's field names to match exactly if they differ; do not guess.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mcpServer.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the real entry points**

```ts
// packages/mekiri-proxy/bin/daemon.ts
import { createDaemon } from "../src/daemon.js";

const port = Number(process.argv[2] ?? 8791);
createDaemon({
  port,
  upstream: { protocol: "https", host: "api.anthropic.com", port: 443 },
}).catch((err) => {
  console.error("mekiri-proxy daemon failed to start:", err);
  process.exit(1);
});
```

```ts
// packages/mekiri-proxy/bin/mcp-server.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon } from "../src/daemonEnsure.js";
import { createToolHandlers, postControlRuleOverHttp } from "../src/mcpServer.js";

const PORT = Number(process.env.MEKIRI_PROXY_PORT ?? 8791);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    throw new Error("CLAUDE_CODE_SESSION_ID is not set -- mekiri-proxy's MCP server must be run by Claude Code, not standalone");
  }
  const depth = Number(process.env.MEKIRI_SPROUT_DEPTH ?? 0);

  const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const daemonEntry = path.join(__dirname, "daemon.ts");
  await ensureDaemon({ port: PORT, spawnCommand: tsxBin, spawnArgs: [daemonEntry, String(PORT)] });

  const handlers = createToolHandlers({
    sessionId,
    dir: process.cwd(),
    depth,
    daemonPort: PORT,
    postControlRule: postControlRuleOverHttp(PORT),
  });

  const server = new McpServer({ name: "mekiri-proxy", version: "0.1.0" });

  server.registerTool(
    "prune",
    {
      description: "Срезать хвост текущей сессии от указанной цитаты до текущего момента, заменив его на дистиллят.",
      inputSchema: {
        quote: z.string(),
        note_type: z.enum(["portal", "death_reload"]),
        fruit: z.unknown(),
        keep_code: z.boolean(),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.prune(args)) }] })
  );

  server.registerTool(
    "configure_mekiri",
    {
      description: "Патчит рантайм-конфиг Mekiri для текущей ветки (.mekiri/config.json).",
      inputSchema: { patch: z.record(z.string(), z.unknown()), reason: z.string() },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.configure_mekiri(args as any)) }] })
  );

  // sprout is registered here too, once Task 11 lands -- see that task for the diff.

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("mekiri-proxy MCP server failed to start:", err);
  process.exit(1);
});
```

- [ ] **Step 7: Verify the whole package still builds and tests pass**

Run: `cd packages/mekiri-proxy && npm run build && npm test`
Expected: no TypeScript errors, all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-proxy/src/mcpServer.ts packages/mekiri-proxy/bin packages/mekiri-proxy/test/mcpServer.test.ts
git commit -m "feat(mekiri-proxy): MCP server exposing prune and configure_mekiri (sprout follows separately)"
```

---

### Task 9: Wire this repo's own `.mcp.json` and write the package README

This is the point where `prune` becomes actually usable in a real session — the owner's stated priority is satisfied as of this task, independent of whether `sprout` (Tasks 10-11) ever lands.

**Files:**
- Create: `.mcp.json` (repo root — verify it doesn't already exist and would conflict; if it does, merge rather than overwrite)
- Create: `packages/mekiri-proxy/README.md`

**Interfaces:** None — this task produces configuration and documentation, not code.

- [ ] **Step 1: Check for an existing root `.mcp.json`**

Run: `cat /home/pol/dev/rollback/.mcp.json 2>/dev/null || echo "does not exist"`
If it exists, read it fully before Step 2 and merge the new server into its existing `mcpServers` object rather than overwriting the file.

- [ ] **Step 2: Write (or merge into) `.mcp.json`**

```json
{
  "mcpServers": {
    "mekiri-proxy": {
      "command": "npx",
      "args": ["tsx", "packages/mekiri-proxy/bin/mcp-server.ts"]
    }
  }
}
```

- [ ] **Step 3: Write `packages/mekiri-proxy/README.md`**

This must be self-sufficient for an agent on a different machine, with no memory of this project's history — write it as if the reader has only just cloned the repo.

```markdown
# mekiri-proxy

Даёт любой сессии Claude Code (обычной, не отдельному REPL) настоящий `prune`/`configure_mekiri` — переписывая `messages[]` на уровне HTTP-запроса к Anthropic API, до того как он туда уйдёт. Локальный вид беседы в интерфейсе не трогается, срезается только то, что реально уходит по проводу.

**Текущий статус (альфа)**: `prune`/`configure_mekiri` реализованы и рабочие. `sprout` (тёплый клон) — в разработке отдельным шагом поверх уже проверенного `prune`, пока не зарегистрирован как тул.

Полный дизайн: [`../../docs/superpowers/specs/2026-07-29-mekiri-proxy-design.md`](../../docs/superpowers/specs/2026-07-29-mekiri-proxy-design.md). Эмпирическое обоснование (кеш переживает срез хвоста): [`../../wire-prune-findings.md`](../../wire-prune-findings.md).

## ⚠️ Важно перед установкой

Этот пакет заворачивает HTTP-трафик Claude Code (включая подписочную OAuth-аутентификацию, если вы залогинены через Free/Pro/Max) через локальный прокси на вашей машине. Anthropic в 2026 году усилила детекцию нестандартных клиентов, использующих подписочные токены. Установка и использование — на ваш страх и риск (см. `wire-prune-findings.md` §3 для деталей). Альфа-стадия, только для тех, кто это осознанно принимает.

## Установка

1. Клонируйте этот репозиторий и установите зависимости:
   ```bash
   git clone <repo-url>
   cd rollback
   npm install
   ```
2. В корне проекта, где вы хотите включить Mekiri (может быть этот же репозиторий или любой другой), добавьте в `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "mekiri-proxy": {
         "command": "npx",
         "args": ["tsx", "/абсолютный/путь/до/rollback/packages/mekiri-proxy/bin/mcp-server.ts"]
       }
     }
   }
   ```
3. Задайте `ANTHROPIC_BASE_URL` в окружении, где будет запущен Claude Code (например, в `~/.bashrc`/`~/.zshrc`, или в переменных окружения IDE):
   ```bash
   export ANTHROPIC_BASE_URL="http://127.0.0.1:8791"
   ```
   Переменная читается Claude Code **один раз при старте процесса** — если сессия уже запущена, перезапустите её после установки этой переменной.
4. Запустите (или перезапустите) Claude Code в целевом проекте. При первом обращении к тулзам Mekiri фоновый демон поднимется автоматически (см. `daemonEnsure.ts`) — вручную ничего стартовать не нужно.

## Что дальше проверить самостоятельно

- `prune` покажет ошибку тула, если демон не поднялся — проверьте `curl http://127.0.0.1:8791/health`, должно вернуть `{"status":"ok","service":"mekiri-proxy-daemon"}`.
- Активные срезы хранятся в `~/.mekiri-proxy/rules.json` (переопределяется `MEKIRI_PROXY_STATE_DIR`).
- Живой smoke-тест против настоящего API — `npm run test:live` в `packages/mekiri-proxy` (не запускается по умолчанию, требует реального биллинга).
```

- [ ] **Step 4: Commit**

```bash
git add .mcp.json packages/mekiri-proxy/README.md
git commit -m "docs(mekiri-proxy): self-sufficient install instructions and project .mcp.json wiring"
```

---

### Task 10: `spawnClone` — sprout's child-process spawn logic

Starts the `sprout` half of the plan, now that `prune` (Tasks 1-9) is built and dogfoodable on its own. This task only builds the spawning primitive — it is not wired into the MCP server until Task 11.

**Files:**
- Create: `packages/mekiri-proxy/src/spawnClone.ts`
- Test: `packages/mekiri-proxy/test/spawnClone.test.ts`
- Create: `packages/mekiri-proxy/test/fixtures/fake-claude.mjs` (test fixture standing in for the `claude` binary)

**Interfaces:**
- Produces: `spawnClone(args: SpawnCloneArgs): Promise<SpawnCloneResult>` where `SpawnCloneArgs = { sessionId: string; task: string; dir: string; proxyPort: number; depth: number; claudeBin?: string }`, `SpawnCloneResult = { childSessionId: string; result: string }`.

- [ ] **Step 1: Write the test fixture — a fake `claude` binary**

```js
// packages/mekiri-proxy/test/fixtures/fake-claude.mjs
// Stands in for the real `claude` CLI in tests: echoes back a JSON result
// shaped like `claude -p ... --output-format json` would, without touching
// the network. Fails on its first invocation (tracked via a marker file
// passed as FAKE_CLAUDE_FAIL_ONCE_MARKER) to exercise the retry path.
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const marker = process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER;
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "1");
  process.stderr.write("Error: Message abc-123 not found in session xyz\n");
  process.exit(1);
}
if (marker) unlinkSync(marker);

process.stdout.write(JSON.stringify({ session_id: "child-session-456", result: "clone finished the task" }));
process.exit(0);
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/mekiri-proxy/test/spawnClone.test.ts
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { spawnClone } from "../src/spawnClone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.mjs");

describe("spawnClone", () => {
  const marker = path.join(__dirname, "fixtures", ".fail-once-marker");

  afterEach(() => {
    if (existsSync(marker)) unlinkSync(marker);
  });

  it("spawns the clone process and parses its JSON result", async () => {
    const result = await spawnClone({
      sessionId: "parent-session",
      task: "do the thing",
      dir: "/tmp",
      proxyPort: 8791,
      depth: 1,
      claudeBin: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE],
    });
    expect(result).toEqual({ childSessionId: "child-session-456", result: "clone finished the task" });
  });

  it("retries once on the transient fork-not-found error, then succeeds", async () => {
    process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER = marker;
    const result = await spawnClone({
      sessionId: "parent-session",
      task: "do the thing",
      dir: "/tmp",
      proxyPort: 8791,
      depth: 1,
      claudeBin: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE],
    });
    expect(result.childSessionId).toBe("child-session-456");
    delete process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/spawnClone.test.ts`
Expected: FAIL — `Cannot find module '../src/spawnClone.js'`

- [ ] **Step 4: Implement `spawnClone.ts`**

```ts
// packages/mekiri-proxy/src/spawnClone.ts
import { spawn } from "node:child_process";

export interface SpawnCloneArgs {
  sessionId: string;
  task: string;
  dir: string;
  proxyPort: number;
  depth: number;
  claudeBin?: string;
  /** Test-only escape hatch: extra argv entries inserted before the real
   *  claude CLI flags, used to point at a fixture script instead of the
   *  real binary. Always `[]` in production. */
  claudeArgsPrefix?: string[];
}

export interface SpawnCloneResult {
  childSessionId: string;
  result: string;
}

const FORK_RETRY_DELAYS_MS = [50, 100, 200, 400];

function frameTask(task: string): string {
  return (
    "Ты — тёплый клон родительской сессии Mekiri. Унаследованный контекст — актив, не балласт. " +
    "Задача считается завершённой только после того, как ты вернёшь итоговый результат родителю.\n\n" +
    `Задача: ${task}`
  );
}

function runOnce(args: SpawnCloneArgs): Promise<SpawnCloneResult> {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      ...(args.claudeArgsPrefix ?? []),
      "--resume",
      args.sessionId,
      "--fork-session",
      "-p",
      frameTask(args.task),
      "--output-format",
      "json",
    ];
    const child = spawn(args.claudeBin ?? "claude", cliArgs, {
      cwd: args.dir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${args.proxyPort}`,
        MEKIRI_SPROUT_DEPTH: String(args.depth),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `clone process exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ childSessionId: parsed.session_id, result: parsed.result });
      } catch {
        reject(new Error(`clone process produced non-JSON output: ${stdout}`));
      }
    });
    child.on("error", reject);
  });
}

function isTransientForkError(err: unknown): boolean {
  return err instanceof Error && /not found in session/.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnClone(args: SpawnCloneArgs): Promise<SpawnCloneResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(args);
    } catch (err) {
      const attemptsLeft = attempt < FORK_RETRY_DELAYS_MS.length;
      if (!isTransientForkError(err) || !attemptsLeft) throw err;
      await sleep(FORK_RETRY_DELAYS_MS[attempt]);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/spawnClone.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-proxy/src/spawnClone.ts packages/mekiri-proxy/test/spawnClone.test.ts packages/mekiri-proxy/test/fixtures/fake-claude.mjs
git commit -m "feat(mekiri-proxy): sprout child-process spawning with fork-race retry"
```

---

### Task 11: Wire `sprout` into `mcpServer`

**Files:**
- Modify: `packages/mekiri-proxy/src/mcpServer.ts`
- Modify: `packages/mekiri-proxy/bin/mcp-server.ts`
- Modify: `packages/mekiri-proxy/test/mcpServer.test.ts`

**Interfaces:**
- Consumes: `spawnClone` (Task 10), `mekiri-core`'s `loadConfig`.
- Produces: adds `sprout` to the object `createToolHandlers` returns, alongside the existing `prune`/`configure_mekiri`.

- [ ] **Step 1: Write the failing test**

Append to `packages/mekiri-proxy/test/mcpServer.test.ts` (the `vi.mock("mekiri-core", ...)` block at the top of the file needs `loadConfig: vi.fn(async () => actual.defaultConfig())` added to its returned object):

```ts
describe("sprout handler", () => {
  it("returns depth_limit_exceeded when own depth is at the configured limit", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 1, daemonPort: 8791, postControlRule: vi.fn() });
    // default config's sprout.depth_limit is 1 (see mekiri-core's defaultConfig) -- depth 1 means already at the ceiling
    const result = await handlers.sprout({ task: "investigate X" });
    expect(result).toEqual({ status: "depth_limit_exceeded" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcpServer.test.ts`
Expected: FAIL — `handlers.sprout is not a function`

- [ ] **Step 3: Add the `sprout` handler to `mcpServer.ts`**

Add these imports at the top of `packages/mekiri-proxy/src/mcpServer.ts`:

```ts
import { loadConfig } from "mekiri-core";
import { spawnClone } from "./spawnClone.js";
```

Add these types alongside `PruneResult`/`ConfigureResult`:

```ts
interface SproutArgs {
  task: string;
  wait_mode?: "sync" | "async";
}

type SproutResult =
  | { status: "ok"; child_session_id: string; result: string }
  | { status: "depth_limit_exceeded" };
```

Add this method inside the object `createToolHandlers` returns, alongside `prune`/`configure_mekiri`:

```ts
    async sprout(args: SproutArgs): Promise<SproutResult> {
      const config = await loadConfig(context.dir);
      if (context.depth >= config.sprout.depth_limit) {
        return { status: "depth_limit_exceeded" };
      }

      const { childSessionId, result } = await spawnClone({
        sessionId: context.sessionId,
        task: args.task,
        dir: context.dir,
        proxyPort: context.daemonPort,
        depth: context.depth + 1,
      });

      await appendAuditEntry(context.dir, {
        event: "sprout",
        timestamp: new Date().toISOString(),
        sessionId: context.sessionId,
        childSessionId,
        branchLength: 0,
        harvestLength: result.length,
      });

      return { status: "ok", child_session_id: childSessionId, result };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mcpServer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the `sprout` tool in `bin/mcp-server.ts`**

Replace the `// sprout is registered here too, once Task 11 lands -- see that task for the diff.` comment in `packages/mekiri-proxy/bin/mcp-server.ts` with:

```ts
  server.registerTool(
    "sprout",
    {
      description: "Форкнуть тёплого клона текущей сессии на изолированную подзадачу, унаследовав весь текущий контекст.",
      inputSchema: { task: z.string(), wait_mode: z.enum(["sync", "async"]).optional() },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.sprout(args)) }] })
  );
```

- [ ] **Step 6: Verify the whole package still builds and tests pass**

Run: `cd packages/mekiri-proxy && npm run build && npm test`
Expected: no TypeScript errors, all tests PASS.

- [ ] **Step 7: Update the README's status note**

In `packages/mekiri-proxy/README.md`, change:

```markdown
**Текущий статус (альфа)**: `prune`/`configure_mekiri` реализованы и рабочие. `sprout` (тёплый клон) — в разработке отдельным шагом поверх уже проверенного `prune`, пока не зарегистрирован как тул.
```

to:

```markdown
**Текущий статус (альфа)**: `prune`/`sprout`/`configure_mekiri` реализованы и рабочие.
```

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-proxy/src/mcpServer.ts packages/mekiri-proxy/bin/mcp-server.ts packages/mekiri-proxy/test/mcpServer.test.ts packages/mekiri-proxy/README.md
git commit -m "feat(mekiri-proxy): wire sprout into the MCP server on top of the proven prune path"
```

---

### Task 12: Opt-in live smoke test against the real API

**Files:**
- Create: `packages/mekiri-proxy/test/live.smoke.test.ts`
- Modify: `packages/mekiri-proxy/package.json` (add `"test:live"` script)
- Modify: `packages/mekiri-proxy/vitest.config.ts` (exclude live tests from the default run)

**Interfaces:** None new — exercises the `prune` stack built in Tasks 1-9 end-to-end. (A `sprout` live smoke test is natural follow-up work once Task 11 has had some real dogfooding, not included here — this task stays focused on the priority the owner named.)

- [ ] **Step 1: Exclude live tests from the default suite**

```ts
// packages/mekiri-proxy/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.MEKIRI_PROXY_LIVE_TEST ? [] : ["**/*.smoke.test.ts"],
  },
});
```

- [ ] **Step 2: Add the `test:live` script**

In `packages/mekiri-proxy/package.json`'s `"scripts"`:

```json
"test:live": "MEKIRI_PROXY_LIVE_TEST=1 vitest run test/live.smoke.test.ts"
```

- [ ] **Step 3: Write the live smoke test**

```ts
// packages/mekiri-proxy/test/live.smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemon } from "../src/daemon.js";
import { postControlRuleOverHttp } from "../src/mcpServer.js";

// Requires a real, authenticated `claude` CLI on PATH and the owner's
// explicit, already-granted acceptance of routing subscription traffic
// through a local relay for testing (see wire-prune-findings.md §3). Not
// part of the default suite -- run explicitly via `npm run test:live`.
describe("live smoke test", () => {
  let stateDir: string;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  const PORT = 18999;

  beforeAll(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-live-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
    daemon = await createDaemon({ port: PORT, upstream: { protocol: "https", host: "api.anthropic.com", port: 443 } });
  });

  afterAll(async () => {
    await daemon.close();
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("prompt caching survives a tail cut applied through the real daemon", async () => {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}` };

    const turn1 = JSON.parse(
      execFileSync("claude", ["-p", "Turn 1. Reply with exactly: ACK 1", "--output-format", "json"], { env }).toString()
    );
    const sessionId = turn1.session_id;

    for (const n of [2, 3]) {
      execFileSync("claude", ["--resume", sessionId, "-p", `Turn ${n}. Reply with exactly: ACK ${n}`, "--output-format", "json"], { env });
    }

    await postControlRuleOverHttp(PORT)({
      sessionId,
      dir: process.cwd(),
      rule: {
        matchQuote: "ACK 2",
        replacement: [
          { role: "user", content: "[MEKIRI PORTAL] cut everything before this." },
          { role: "assistant", content: "distillate: turns 1-2 were a numbering test." },
        ],
      },
    });

    const afterCut = JSON.parse(
      execFileSync("claude", ["--resume", sessionId, "-p", "Turn 4. Reply with exactly: ACK 4", "--output-format", "json"], { env }).toString()
    );

    expect(afterCut.usage.cache_read_input_tokens).toBeGreaterThan(0);
  }, 60000);
});
```

- [ ] **Step 4: Run it manually to confirm it works (real API cost applies)**

Run: `cd packages/mekiri-proxy && npm run test:live`
Expected: PASS — confirms `cache_read_input_tokens > 0` on the request immediately following the cut, i.e. the cache was not fully invalidated. This is a manual, explicit run — do not add it to CI or any default test invocation.

- [ ] **Step 5: Run the default suite once more to confirm the live test is excluded**

Run: `cd packages/mekiri-proxy && npm test`
Expected: PASS, and the summary does not mention `live.smoke.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-proxy/test/live.smoke.test.ts packages/mekiri-proxy/package.json packages/mekiri-proxy/vitest.config.ts
git commit -m "test(mekiri-proxy): opt-in live smoke test proving cache survives a real wire-level cut"
```

---

## Self-Review Notes

- **Priority ordering honored**: Tasks 1-9 build and wire up a fully working `prune`/`configure_mekiri` with zero dependency on `sprout`/`spawnClone` — the owner can dogfood `prune` in their own session as soon as Task 9 lands. Tasks 10-11 add `sprout` afterward, as a pure addition (Task 11 modifies `mcpServer.ts`/`bin/mcp-server.ts` rather than restructuring anything Task 8 built).
- **Spec coverage**: §1 architecture → Tasks 1, 5, 6, 8. §2 session identification → Task 3. §3 tool schemas → Tasks 8 (prune/configure_mekiri), 11 (sprout). §4 data flow → Task 8 (prune/configure_mekiri), Tasks 10-11 (sprout), boundary risk → Task 2. §5 audit format → Task 7. §6 persistence/errors → Tasks 3, 5, 6. §7 testing/distribution → Tasks 1-12 collectively, README → Task 9.
- **Placeholder scan**: no TBD/TODO; the one place a decision is deferred (Task 2's outcome, Task 8 Step 1) is deferred to a *specific, already-scheduled* task's written output, not left vague.
- **Type consistency**: `RewriteRule`/`RewriteMessage` (Task 3) used identically in Tasks 4, 5, 8; `SpawnCloneArgs`/`SpawnCloneResult` (Task 10) used identically in Task 11; tool result shapes match the design spec §3 exactly; `McpServerContext` is defined once in Task 8 with the full shape `sprout` will need, so Task 11 adds a method without touching the type.
- **Known follow-up, explicitly out of scope here** (per design spec's own "вне скоупа"): archiving `packages/mekiri-host` to a branch (deferred until this package is proven working, per the owner's explicit instruction); adapting `mekiri-core`'s `sessionTree`/`metricsReport` to a flat (no parent/child) session model; `mekiri-gate`/`mekiri-tuning` skill text rewrite (tool signatures didn't change, so likely minimal, but not verified here); a `sprout`-specific live smoke test (natural follow-up once Task 11 has some real dogfooding behind it); wiring this repo's live session to actually *use* `mekiri-proxy` day-to-day (Task 9 only adds the config, doesn't restart the current conversation into it).
