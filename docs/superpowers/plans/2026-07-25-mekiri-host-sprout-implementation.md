# Mekiri Host Sprout/Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sprout`/`harvest` to `mekiri-host`: a warm-clone tool that forks the current session, runs an isolated sub-conversation (with full internal `prune` support) to completion, and returns its result to the parent synchronously — the second half of the core primitive, alongside the already-shipped `prune`.

**Architecture:** Since this iteration is `wait_mode: "sync"`-only, `sprout` is just an `async` MCP tool handler that internally drives a second, independent `query()` loop to completion and returns its result as the tool's own `tool_result` — the parent's existing `for await` loop in `repl.ts` needs no changes at all. The clone's own loop (`runClone`, new) deliberately does not share code with `repl.ts`'s loop (accepted duplication, lower risk to the already-shipped parent REPL) but does reuse the same building blocks (`createInputQueue`, `createLiveTranscript`, and the permission/query-options logic, extracted into their own module this plan to avoid a circular import between `tools.ts` and the new `clone.ts`).

**Tech Stack:** TypeScript, Node.js 24, Vitest, Zod, `@anthropic-ai/claude-agent-sdk`, `mekiri-core` (already-shipped `loadConfig`, `appendAuditEntry`, `SproutAuditEntry`).

## Global Constraints

- `wait_mode` is always `"sync"` in this iteration — no async/background sprout, no `parallelism > 1`. (design spec §1)
- `depth_limit` is read from `.mekiri/config.json` via `mekiri-core`'s `loadConfig`/`defaultConfig` (default `1`), never passed as a tool argument — there is no `configure_mekiri` tool in this iteration to change it. (design spec §3)
- `sprout` and `harvest` are **permanently registered MCP tools in every session** (parent, clone, nested clone) — never conditionally present, per the cache-identity invariant established in `2026-07-24-core-primitive-design.md` §2. `harvest` called outside a clone context is a **runtime error result**, not a missing tool. (design spec §3)
- `prune` must work fully inside a clone's own loop (the same `pendingSwitch`/`q.return()`/fresh-`query()` pattern used by the parent) — this is the explicit motivating use case (rolling back a failed hypothesis inside a clone, including `keep_code:false` mutation rollback, before trying the next one). (design spec §2)
- Fork and audit-log write are split in time for `sprout`: fork happens immediately via the SDK's raw `forkSession` (not `mekiri-core`'s `createBranch`, which bundles fork+audit atomically and needs both lengths known upfront — `sprout`'s lengths are only known after the clone finishes); the audit entry is written afterward via `mekiri-core`'s already-exported `appendAuditEntry`, with real `branchLength`/`harvestLength`. (design spec §4)
- `removedBranchLength`/`fruitLength`/`branchLength`/`harvestLength` are character-length proxies (`JSON.stringify(...).length`), matching the convention already established in `mekiri-core` and in `prune`'s own implementation (`packages/mekiri-host/src/tools.ts`) — never a line/message count for one side and a character count for the other.
- A clone that finishes its turn without calling `harvest` is not an error — its last assistant text becomes the result automatically, flagged as `harvested_implicitly: true` in the `sprout` tool's response. (design spec §2)
- No `promote` (leader-replacement) — explicitly out of scope for this iteration, deferred as a future-vision item.

---

### Task 1: Extract `canUseTool`/`buildQueryOptions`/`formatQueryErrorMessage` into their own module

**Files:**
- Create: `packages/mekiri-host/src/permissions.ts`
- Modify: `packages/mekiri-host/src/repl.ts`
- Modify: `packages/mekiri-host/test/repl.smoke.test.ts:8`

**Interfaces:**
- Consumes: nothing new.
- Produces: `canUseTool: CanUseTool`, `formatQueryErrorMessage(error: unknown): string`, `buildQueryOptions(context: {resume, cwd, mcpServers}): Options` — moved verbatim from `repl.ts`, re-exported from `permissions.ts`. Consumed by Task 2's `clone.ts` (which needs `buildQueryOptions` for its own `query()` calls, and must not import from `repl.ts` to avoid a circular import once `tools.ts` imports `clone.ts` and `repl.ts` imports `tools.ts`).

**Background:** `repl.ts` currently defines `canUseTool`, `formatQueryErrorMessage`, and `buildQueryOptions` itself, and `repl.smoke.test.ts` imports all three from `../src/repl.js`. This task moves them, unchanged, to a new `permissions.ts` module with no other source changes — a pure refactor to unblock Task 2 without touching any behavior. Every existing test must still pass after this move.

- [ ] **Step 1: Create `permissions.ts` with the moved code**

Create `packages/mekiri-host/src/permissions.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";

// mekiri-host is only responsible for permissioning its own MCP tool(s) —
// the "mekiri" server registered by createMekiriTools (prune, sprout,
// harvest). Everything else (Bash, file edits, other MCP servers, etc.) is
// explicitly DENIED rather than falling through to any "default" handling.
//
// Supplying any canUseTool callback makes the SDK route every
// prompt-requiring tool decision through it (there is no partial opt-in) —
// but read-only tools like Read/Grep/Glob are auto-approved by the SDK's own
// default handling before they ever reach this callback (mirroring Claude
// Code's normal UX, where read-only operations don't prompt). This was
// confirmed by real dogfooding: reading a real file from this repo worked
// fine in live runs of this REPL both before and after this callback was
// added. Only tools that would normally need an approval prompt — Bash,
// Edit, Write, and any other MCP server's tools — actually reach here, and
// the SDK's own contract for CanUseTool is fail-closed: returning `null`
// means "the consumer already sent a control_response out-of-band," and if
// that's not true the tool stays blocked indefinitely with no error
// surfaced anywhere. This host does not do out-of-band responses, so `null`
// is never a safe return value here — it would silently reintroduce the
// exact hang this callback exists to fix, just without even a visible
// "needs your permission" message. Returning an explicit `deny` instead
// fails fast and visibly: the model sees the denial and can tell the user
// mekiri-host doesn't support interactive tool-permission prompts yet.
//
// Matching the "mcp__mekiri__" prefix rather than a fixed list of literal
// tool names keeps the allow side future-proof: any tool added to
// createMekiriTools later is auto-approved without another change here, and
// the prefix can't collide with other servers since the SDK's
// "mcp__<serverName>__<toolName>" naming ties it to the "mekiri" name we
// pass to createSdkMcpServer.
export const canUseTool: CanUseTool = async (toolName) => {
  if (toolName.startsWith("mcp__mekiri__")) {
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message:
      "mekiri-host is a minimal REPL that doesn't yet support interactive tool-permission prompts; only mekiri's own tools (mcp__mekiri__*) are auto-approved in this iteration.",
  };
};

// Formats a thrown query()/stream error (auth expiry, rate limit, network
// blip, etc.) into the message shown to the user when a live turn loop
// fails mid-session. Kept as a small pure function so the "don't crash,
// tell the user honestly, keep the session id, let them resume" behavior
// can be unit-tested without needing to trigger a real query() failure —
// those aren't reproducible deterministically in a fast test, and aren't
// worth the live API cost/flakiness to force.
export function formatQueryErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `mekiri-host: query error: ${detail}. Type your next message to try resuming this session, or Ctrl+C to exit.`;
}

// Builds the exact options object passed to query() inside runRepl()/
// runClone(), split out so tests can assert on the real code path (that
// canUseTool is actually wired in) instead of only on the standalone
// canUseTool export.
export function buildQueryOptions(context: {
  resume: string | undefined;
  cwd: string;
  mcpServers: Options["mcpServers"];
}): Options {
  return {
    resume: context.resume,
    cwd: context.cwd,
    mcpServers: context.mcpServers,
    canUseTool,
  };
}
```

Note: the `import { query } from "@anthropic-ai/claude-agent-sdk"` line above is unused in this file (it was only used by `runRepl`, which stays in `repl.ts`) — do not include it. Only import `CanUseTool` and `Options` as types.

- [ ] **Step 2: Remove the moved code from `repl.ts` and import it from `permissions.ts` instead**

Modify `packages/mekiri-host/src/repl.ts`: replace lines 1-80 (the imports through the end of `buildQueryOptions`) with:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { createMekiriTools } from "./tools.js";
import { buildQueryOptions, formatQueryErrorMessage } from "./permissions.js";

export interface ReplOptions {
  resumeSessionId?: string;
  dir: string;
}
```

The rest of the file (`runRepl` and everything below it, currently starting at line 82) is unchanged — `buildQueryOptions` and `formatQueryErrorMessage` are now imported instead of defined locally. `repl.ts` no longer needs to export `canUseTool` directly (nothing in this file references it anymore now that `buildQueryOptions` — which internally used it — has moved too), but re-export it anyway for backward compatibility with anything that might import it from `repl.ts`:

```ts
export { canUseTool, buildQueryOptions, formatQueryErrorMessage } from "./permissions.js";
```

Add this re-export line immediately after the imports, before `export interface ReplOptions`.

- [ ] **Step 3: Update the test file's import**

Modify `packages/mekiri-host/test/repl.smoke.test.ts:8`, change:

```ts
import { canUseTool, buildQueryOptions, formatQueryErrorMessage } from "../src/repl.js";
```

to:

```ts
import { canUseTool, buildQueryOptions, formatQueryErrorMessage } from "../src/permissions.js";
```

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS, same test count as before this change (25 tests: 21 non-live + 4 live). This task changes no behavior, only where code lives — every existing assertion must still hold.

- [ ] **Step 5: Run the type checker**

Run: `cd packages/mekiri-host && npx tsc --noEmit -p tsconfig.json`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/permissions.ts packages/mekiri-host/src/repl.ts packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "refactor(mekiri-host): extract canUseTool/buildQueryOptions/formatQueryErrorMessage into permissions.ts"
```

---

### Task 2: `runClone` — the clone's own execution loop

**Files:**
- Create: `packages/mekiri-host/src/clone.ts`
- Test: `packages/mekiri-host/test/clone.smoke.test.ts`

**Interfaces:**
- Consumes: `createInputQueue` (`./inputQueue.js`), `createLiveTranscript` (`./liveTranscript.js`), `buildQueryOptions` (`./permissions.js`, Task 1), `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `CloneDynamicContext` type, `RunCloneResult` type, `runClone(task: string, forkedSessionId: string, dir: string, buildTools: (dynamic: CloneDynamicContext) => McpSdkServerConfigWithInstance): Promise<RunCloneResult>` — consumed by Task 4's `handleSprout`.

**Background:** `runClone` knows nothing about `prune`/`sprout`/`harvest` specifically — it only knows about two generic signals a tool handler can raise through the `CloneDynamicContext` callbacks it's given: `onSwitch` (an internal `prune`-style session swap, handled exactly like `repl.ts`'s `pendingSwitch`) and `onHarvest` (a terminal "stop, this is the result" signal). The actual tool set (including the real `prune`/`sprout`/`harvest` tools) is supplied by the caller via `buildTools`, which `runClone` calls once per internal loop iteration is **not** required — call it once, up front, since the same tools object should back every internal `query()` call for this clone (its closures read the loop's mutable state by reference, the same pattern `repl.ts` already uses for the parent). This indirection (rather than `runClone` importing `createMekiriTools` directly) is deliberate: it avoids a circular import, since `tools.ts` (Task 4) will import `runClone` from this file.

If the model's turn ends naturally — no tool call, no `harvest`, no `prune`-triggered switch — that is not an error: the last assistant text becomes the result, flagged via `harvestedImplicitly: true`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-host/test/clone.smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { runClone } from "../src/clone.js";
import type { CloneDynamicContext } from "../src/clone.js";

// These tests make real, billed API calls (query() has no offline mode).
// Kept minimal per the project's live-test-budget policy: prove the
// mechanics (harvest-equivalent termination, natural-completion fallback,
// internal prune-style switching) with synthetic test-only tools rather
// than the real prune/sprout/harvest tools (wired in Task 4's own tests),
// so these tests don't depend on a real model reliably choosing to call a
// specific real tool with specific arguments.

function buildFinishTestTools(dynamic: CloneDynamicContext): McpSdkServerConfigWithInstance {
  const finishTool = tool(
    "test_finish",
    "Call this exact tool with the given result to end the test turn.",
    { result: z.string() },
    async (args) => {
      dynamic.onHarvest(args.result, false);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [finishTool] });
}

describe("runClone live smoke test", () => {
  it("terminates when the harvest-equivalent signal fires and returns that result", async () => {
    const result = await runClone(
      "Call the mcp__mekiri__test_finish tool right now with result set to exactly the string DONE_SIGNAL. Do not say anything else first.",
      undefined,
      process.cwd(),
      buildFinishTestTools,
    );

    expect(result.harvestedImplicitly).toBe(false);
    expect(result.result).toBe("DONE_SIGNAL");
    expect(result.branchLength).toBeGreaterThan(0);
  }, 60_000);

  it("falls back to the last assistant text when the turn ends without a harvest signal", async () => {
    const result = await runClone(
      "Reply with exactly the words FALLBACK_TEXT_HERE and nothing else. Do not call any tool.",
      undefined,
      process.cwd(),
      buildFinishTestTools,
    );

    expect(result.harvestedImplicitly).toBe(true);
    expect(result.result).toContain("FALLBACK_TEXT_HERE");
  }, 60_000);
});
```

Note: `forkedSessionId` is passed as `undefined` in these two tests (matches its `string | undefined` type below, no cast needed) — `runClone` is given an *unforked* fresh session on purpose here (Task 2 tests `runClone`'s generic loop mechanics in isolation; Task 4's tests exercise the real fork). Verify in Step 3 below whether `query({resume: undefined, ...})` behaves as "start a fresh session" (it should, matching `repl.ts`'s own first-ever call with no `--resume` flag) — if it does not, adjust `runClone`'s handling of an undefined/empty initial session id and note the correction in your report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/clone.smoke.test.ts`
Expected: FAIL — `src/clone.ts` doesn't exist yet.

- [ ] **Step 3: Write `clone.ts`**

Create `packages/mekiri-host/src/clone.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RawLine } from "mekiri-core";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { buildQueryOptions } from "./permissions.js";

export interface CloneDynamicContext {
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
  onHarvest: (result: string, needsCleanLook: boolean) => void;
}

export interface RunCloneResult {
  result: string;
  harvestedImplicitly: boolean;
  needsCleanLook: boolean;
  branchLength: number;
}

export async function runClone(
  task: string,
  forkedSessionId: string | undefined,
  dir: string,
  buildTools: (dynamic: CloneDynamicContext) => McpSdkServerConfigWithInstance,
): Promise<RunCloneResult> {
  let transcript = createLiveTranscript();
  let currentInput = createInputQueue();
  currentInput.push(task);
  currentInput.close();

  let currentSessionId = forkedSessionId;
  let pendingSwitch: { newSessionId: string; injectText: string } | null = null;
  let harvested: { result: string; needsCleanLook: boolean } | null = null;
  let lastAssistantText = "";

  const tools = buildTools({
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: clone has no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
    onHarvest: (result, needsCleanLook) => {
      harvested = { result, needsCleanLook };
    },
  });

  while (!harvested) {
    const q = query({
      prompt: currentInput.iterable,
      options: buildQueryOptions({ resume: currentSessionId, cwd: dir, mcpServers: { mekiri: tools } }),
    });

    for await (const message of q) {
      transcript.push(message);

      if (message.type === "system" && message.subtype === "init") {
        currentSessionId = message.session_id;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            lastAssistantText = block.text;
          }
        }
      }

      if (harvested || pendingSwitch) {
        await q.return(undefined);
        break;
      }
    }

    if (harvested) {
      break;
    }

    if (pendingSwitch) {
      const { newSessionId, injectText } = pendingSwitch;
      pendingSwitch = null;
      currentSessionId = newSessionId;
      transcript = createLiveTranscript();
      currentInput = createInputQueue();
      currentInput.push(injectText);
      currentInput.close();
      continue;
    }

    // The turn ended naturally: no tool call switched or harvested. Soft
    // fallback per the design spec — the clone's last text becomes the
    // result rather than treating this as an error.
    return {
      result: lastAssistantText,
      harvestedImplicitly: true,
      needsCleanLook: false,
      branchLength: JSON.stringify(transcript.getLines()).length,
    };
  }

  const finalHarvest = harvested as { result: string; needsCleanLook: boolean };
  return {
    result: finalHarvest.result,
    harvestedImplicitly: false,
    needsCleanLook: finalHarvest.needsCleanLook,
    branchLength: JSON.stringify(transcript.getLines()).length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/clone.smoke.test.ts`
Expected: PASS (2 tests). If the `forkedSessionId: undefined` case doesn't behave as "start fresh" (per the Step 1 note), fix `runClone`'s handling — e.g., only pass `resume` when `currentSessionId` is truthy — and record what you found in your report.

- [ ] **Step 5: Run the full suite and type-check**

Run: `cd packages/mekiri-host && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (27 tests: 25 existing + 2 new), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/clone.ts packages/mekiri-host/test/clone.smoke.test.ts
git commit -m "feat(mekiri-host): add runClone, the clone's own query() execution loop"
```

---

### Task 3: Extend `MekiriToolsContext` and add the `harvest` tool

**Files:**
- Modify: `packages/mekiri-host/src/tools.ts`
- Test: `packages/mekiri-host/test/tools.test.ts` (add to existing file)

**Interfaces:**
- Consumes: nothing new from earlier tasks in this plan (this task only touches the already-shipped `tools.ts`).
- Produces: extended `MekiriToolsContext` (adds `depth: number`, `isClone: boolean`, `onHarvest: (result: string, needsCleanLook: boolean) => void`), `HarvestArgs` type, `handleHarvest(context: MekiriToolsContext, args: HarvestArgs): Promise<PruneToolResult>` — consumed by Task 4 (which adds the `sprout` tool and needs the extended context) and by Task 5 (which updates `repl.ts`'s existing `createMekiriTools` call site to supply the new fields).

**Background:** `harvest` is only meaningful inside a clone. Per the Global Constraints, it is still **always registered** — `handleHarvest` checks `context.isClone` at runtime and returns an error result (not a missing-tool error) when called from the parent.

- [ ] **Step 1: Write the failing tests**

First, update the file's existing import line 5 — merge the new `handleHarvest` import into it rather than adding a second `from "../src/tools.js"` line:

```ts
import { handlePrune, handleHarvest } from "../src/tools.js";
```

Then add, below the existing imports (do not remove the existing `handlePrune` describe block):

```ts
import type { HarvestArgs } from "../src/tools.js";

describe("handleHarvest", () => {
  function makeClonelikeContext(onHarvest: (result: string, needsCleanLook: boolean) => void) {
    return {
      dir: "/irrelevant/for/this/test",
      depth: 1,
      isClone: true,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000099",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest,
    };
  }

  function makeParentContext() {
    return {
      dir: "/irrelevant/for/this/test",
      depth: 0,
      isClone: false,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000098",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {
        throw new Error("onHarvest should never be called when isClone is false");
      },
    };
  }

  it("calls onHarvest with the result and needsCleanLook when isClone is true", async () => {
    let captured: { result: string; needsCleanLook: boolean } | null = null;
    const context = makeClonelikeContext((result, needsCleanLook) => {
      captured = { result, needsCleanLook };
    });

    const args: HarvestArgs = { result: "the distilled answer", needs_clean_look: true };
    const output = await handleHarvest(context, args);

    expect(output.isError).toBeFalsy();
    expect(captured).toEqual({ result: "the distilled answer", needsCleanLook: true });
  });

  it("defaults needsCleanLook to false when needs_clean_look is omitted", async () => {
    let captured: { result: string; needsCleanLook: boolean } | null = null;
    const context = makeClonelikeContext((result, needsCleanLook) => {
      captured = { result, needsCleanLook };
    });

    await handleHarvest(context, { result: "ok" });

    expect(captured).toEqual({ result: "ok", needsCleanLook: false });
  });

  it("returns an error result and never calls onHarvest when isClone is false", async () => {
    const context = makeParentContext();

    const output = await handleHarvest(context, { result: "should not apply" });

    expect(output.isError).toBe(true);
    expect(JSON.stringify(output.content)).toContain("harvest валиден только внутри sprout-клона");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: FAIL — `handleHarvest`/`HarvestArgs` don't exist yet, and the existing `handlePrune` test's context objects are missing the new required fields (`depth`/`isClone`/`onHarvest`), which will also fail to type-check.

- [ ] **Step 3: Extend `MekiriToolsContext` and add `handleHarvest`**

Modify `packages/mekiri-host/src/tools.ts`. Replace the `MekiriToolsContext` interface (lines 51-56) with:

```ts
export interface MekiriToolsContext {
  dir: string;
  depth: number;
  isClone: boolean;
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
  onHarvest: (result: string, needsCleanLook: boolean) => void;
}
```

Add, immediately after the existing `handlePrune` function (after line 126, before `export function createMekiriTools`):

```ts
export interface HarvestArgs {
  result: string;
  needs_clean_look?: boolean;
}

export async function handleHarvest(context: MekiriToolsContext, args: HarvestArgs): Promise<PruneToolResult> {
  if (!context.isClone) {
    return { content: [{ type: "text", text: "harvest валиден только внутри sprout-клона" }], isError: true };
  }
  context.onHarvest(args.result, args.needs_clean_look ?? false);
  return { content: [{ type: "text", text: "ok" }] };
}
```

- [ ] **Step 4: Register the `harvest` tool in `createMekiriTools`**

Modify `packages/mekiri-host/src/tools.ts`'s `createMekiriTools` function (currently lines 128-142): add a `harvestTool` alongside the existing `pruneTool`, and include it in the `tools` array passed to `createSdkMcpServer`:

```ts
export function createMekiriTools(context: MekiriToolsContext): McpSdkServerConfigWithInstance {
  const pruneTool = tool(
    "prune",
    "Cut the dirty tail of the current session: archive it and continue from a distilled note. Use when a side investigation is done and its raw process is no longer needed.",
    {
      quote: z.string().describe("Verbatim opening sentence of your own turn where the garbage begins"),
      note_type: z.enum(["portal", "death_reload"]),
      fruit: z.record(z.string(), z.unknown()).describe("portal: {summary, files_touched?, gotchas?}. death_reload: {tried, ruled_out, facts_learned?, trigger?}"),
      keep_code: z.boolean().default(true),
    },
    async (args) => (await handlePrune(context, args as PruneArgs)) as CallToolResult,
  );

  const harvestTool = tool(
    "harvest",
    "Return your result to the parent that sprouted you and end this clone. Only valid inside a sprout clone.",
    {
      result: z.string().describe("The distilled result to hand back to the parent"),
      needs_clean_look: z
        .boolean()
        .optional()
        .describe("Set true to flag that this result is uncertain and the parent should get a fresh perspective instead of trusting it"),
    },
    async (args) => (await handleHarvest(context, args as HarvestArgs)) as CallToolResult,
  );

  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool, harvestTool] });
}
```

(The `sprout` tool is added in Task 4 — this task deliberately stops at `harvest` so it stays independently reviewable.)

- [ ] **Step 5: Fix the existing `handlePrune` tests' context object**

The existing `describe("handlePrune", ...)` block in `packages/mekiri-host/test/tools.test.ts` has exactly one context builder, `makeContext()` (currently lines 55-64), shared by all three existing tests. It now fails to type-check against the extended `MekiriToolsContext`. Replace it with:

```ts
  function makeContext() {
    return {
      dir: projectDir,
      depth: 0,
      isClone: false,
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId: string, injectText: string) => {
        switchCalls.push({ newSessionId, injectText });
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from a prune-only test");
      },
    };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: PASS (6 tests: 3 existing `handlePrune` + 3 new `handleHarvest`).

- [ ] **Step 7: Run the full suite and type-check**

Run: `cd packages/mekiri-host && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (30 tests: 27 from Tasks 1-2 + 3 new), tsc clean. (`repl.ts`'s own call to `createMekiriTools` in `runRepl` will now fail to type-check until Task 5 updates it — if `tsc` fails specifically on `repl.ts`'s existing `createMekiriTools({...})` call missing the new fields, that is expected and is fixed in Task 5, not here; confirm the *only* type error, if any, is at that one call site before proceeding, and note it in your report rather than fixing it now.)

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-host/src/tools.ts packages/mekiri-host/test/tools.test.ts
git commit -m "feat(mekiri-host): add the harvest tool and extend MekiriToolsContext for clone support"
```

---

### Task 4: `sprout` tool (depth limit, fork, run clone, audit)

**Files:**
- Modify: `packages/mekiri-host/src/tools.ts`
- Test: `packages/mekiri-host/test/tools.test.ts` (add to existing file)

**Interfaces:**
- Consumes: `runClone`, `CloneDynamicContext` (Task 2, `./clone.js`); `handleHarvest`, extended `MekiriToolsContext` (Task 3); `loadConfig`, `appendAuditEntry` from `mekiri-core`; `forkSession` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `SproutArgs` type, `handleSprout(context: MekiriToolsContext, args: SproutArgs): Promise<PruneToolResult>` — registered as the `sprout` tool in `createMekiriTools`, consumed by Task 5's live end-to-end test.

**Background:** `handleSprout` reads `depth_limit` from `.mekiri/config.json` (via `mekiri-core`'s `loadConfig`, default `1`) and compares against `context.depth + 1` — exceeding it returns `depth_limit_exceeded` **before** any fork happens. The actual fork uses the SDK's raw `forkSession` (full copy, no `upToMessageId`) rather than `mekiri-core`'s `createBranch`, per the Global Constraints. Unlike `prune`'s fork (which slices to a specific message and can race the disk-flush timing described in `tools.ts`'s existing comment), `sprout`'s fork has no specific message to look up — it copies whatever is currently on disk — so it does **not** need the same `isTransientForkNotFoundError`/retry wrapper; do not apply it here.

- [ ] **Step 1: Write the failing tests**

First, update the file's import lines. After Task 3, line 5 reads `import { handlePrune, handleHarvest } from "../src/tools.js";` and line 6 reads `import type { RawLine } from "mekiri-core";`, with `import type { HarvestArgs } from "../src/tools.js";` added below the original import block. Change the `../src/tools.js` value import to also include `handleSprout`, and add the two genuinely new imports (`SproutArgs`, `readAuditLog`) — do NOT re-import `mkdtemp`/`rm`/`tmpdir`/`path`, already imported at the top of the file (a duplicate `import { mkdtemp, rm } from "node:fs/promises"` would be a duplicate-identifier compile error). End state of the file's import section:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlePrune, handleHarvest, handleSprout } from "../src/tools.js";
import type { RawLine } from "mekiri-core";
import type { HarvestArgs, SproutArgs } from "../src/tools.js";
import { readAuditLog } from "mekiri-core";
```

Then append the new test block:

```ts
// handleSprout makes real, billed API calls (it drives a full runClone()
// internally). Kept to the minimum needed to prove the mechanics per the
// project's live-test-budget policy.
describe("handleSprout", () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns depth_limit_exceeded without forking when the child depth exceeds the default limit", async () => {
    // Default depth_limit is 1 (mekiri-core's defaultConfig, no .mekiri/config.json
    // written in this test project dir), so a context already at depth 1 must
    // refuse to sprout a depth-2 child.
    const context = {
      dir: projectDir,
      depth: 1,
      isClone: true,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000097",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {},
    };

    const output = await handleSprout(context, { task: "irrelevant, should be refused before starting" });

    expect(output.isError).toBeFalsy();
    expect(JSON.stringify(output.content)).toContain("depth_limit_exceeded");
  });

  it("forks a real child, runs it to a real harvest, and records a sprout audit entry with real lengths", async () => {
    // Seed a minimal real session file for handleSprout's context.getSessionId()
    // to fork from, following the same UUID-format-id + CLAUDE_CONFIG_DIR/dir
    // convention established in mekiri-core's own branch.test.ts.
    const { promises: fs } = await import("node:fs");
    const sanitizeDir = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");
    const parentSessionId = "bbbbbbbb-0000-4000-8000-000000000001";
    const sessionFilePath = path.join(configDir, "projects", sanitizeDir(projectDir), `${parentSessionId}.jsonl`);
    await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
    await fs.writeFile(
      sessionFilePath,
      `${JSON.stringify({
        type: "user",
        uuid: "cccccccc-0000-4000-8000-000000000001",
        parentUuid: null,
        isSidechain: false,
        message: { role: "user", content: "hello" },
      })}\n`,
      "utf8",
    );

    const context = {
      dir: projectDir,
      depth: 0,
      isClone: false,
      getSessionId: () => parentSessionId,
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {},
    };

    const args: SproutArgs = {
      task: "Call the mcp__mekiri__harvest tool right now with result set to exactly the string SPROUT_TEST_RESULT. Do not say anything else first.",
    };
    const output = await handleSprout(context, args);

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.child_session_id).not.toBe(parentSessionId);
    expect(parsed.result).toBe("SPROUT_TEST_RESULT");
    expect(parsed.harvested_implicitly).toBeUndefined();

    const log = await readAuditLog(projectDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("sprout");
    if (log[0].event === "sprout") {
      expect(log[0].sessionId).toBe(parentSessionId);
      expect(log[0].childSessionId).toBe(parsed.child_session_id);
      expect(log[0].branchLength).toBeGreaterThan(0);
      expect(log[0].harvestLength).toBe(JSON.stringify("SPROUT_TEST_RESULT").length);
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: FAIL — `handleSprout`/`SproutArgs` don't exist yet.

- [ ] **Step 3: Write `handleSprout` and register the `sprout` tool**

Modify `packages/mekiri-host/src/tools.ts`. Add to the imports at the top of the file:

```ts
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, appendAuditEntry } from "mekiri-core";
import type { SproutAuditEntry } from "mekiri-core";
import { runClone } from "./clone.js";
import type { CloneDynamicContext } from "./clone.js";
```

Add, after `handleHarvest` (added in Task 3) and before `createMekiriTools`:

```ts
export interface SproutArgs {
  task: string;
}

export async function handleSprout(context: MekiriToolsContext, args: SproutArgs): Promise<PruneToolResult> {
  const config = await loadConfig(context.dir);
  const childDepth = context.depth + 1;
  if (childDepth > config.sprout.depth_limit) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "depth_limit_exceeded" }) }] };
  }

  const { sessionId: forkedSessionId } = await forkSession(context.getSessionId(), { dir: context.dir });

  const buildTools = (dynamic: CloneDynamicContext) =>
    createMekiriTools({
      dir: context.dir,
      depth: childDepth,
      isClone: true,
      ...dynamic,
    });

  const cloneResult = await runClone(args.task, forkedSessionId, context.dir, buildTools);

  const auditEntry: SproutAuditEntry = {
    event: "sprout",
    timestamp: new Date().toISOString(),
    sessionId: context.getSessionId(),
    childSessionId: forkedSessionId,
    branchLength: cloneResult.branchLength,
    harvestLength: JSON.stringify(cloneResult.result).length,
  };
  await appendAuditEntry(context.dir, auditEntry);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          branch_type: "sprout",
          child_session_id: forkedSessionId,
          result: cloneResult.result,
          ...(cloneResult.harvestedImplicitly ? { harvested_implicitly: true } : {}),
          ...(cloneResult.needsCleanLook ? { needs_clean_look: true } : {}),
        }),
      },
    ],
  };
}
```

Modify `createMekiriTools` to add the `sproutTool` and include it in the tools array:

```ts
  const sproutTool = tool(
    "sprout",
    "Fork a warm clone of the current session to work a side task in isolation, without disturbing this session. The clone inherits full context and can use prune/sprout/harvest itself. Call harvest inside the clone when its task is done.",
    {
      task: z.string().describe("The clone's new main task, appended to its copy of the current context"),
    },
    async (args) => (await handleSprout(context, args as SproutArgs)) as CallToolResult,
  );

  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool, sproutTool, harvestTool] });
```

(Replace the `return createSdkMcpServer(...)` line from Task 3 with this one, which adds `sproutTool` to the array.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: PASS (8 tests: 6 from Task 3 + 2 new). This spends a small amount of real API budget for the second test — expected and authorized per this project's established live-test-budget policy.

- [ ] **Step 5: Run the full suite and type-check**

Run: `cd packages/mekiri-host && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (32 tests: 30 from Tasks 1-3 + 2 new). `tsc` should now show exactly the one pre-existing error at `repl.ts`'s `createMekiriTools` call site noted in Task 3 Step 7 (still unfixed until Task 5) — confirm no *other* new type errors were introduced.

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/tools.ts packages/mekiri-host/test/tools.test.ts
git commit -m "feat(mekiri-host): add the sprout tool (depth limit, fork, run clone, audit)"
```

---

### Task 5: Wire into `repl.ts` and add a live end-to-end smoke test

**Files:**
- Modify: `packages/mekiri-host/src/repl.ts`
- Test: `packages/mekiri-host/test/repl.smoke.test.ts` (add to existing file)

**Interfaces:**
- Consumes: extended `MekiriToolsContext` (Task 3), `handleSprout`/`handleHarvest` (Tasks 3-4, indirectly via `createMekiriTools`).
- Produces: nothing new — this task proves the whole feature works end-to-end from the parent's real `runRepl()` loop, the actual code path a user's REPL session runs.

- [ ] **Step 1: Fix `repl.ts`'s `createMekiriTools` call site**

Modify `packages/mekiri-host/src/repl.ts`'s `runRepl` function — the existing `createMekiriTools({...})` call (currently around line 91-101) needs the three new required `MekiriToolsContext` fields. Replace it with:

```ts
  const tools = createMekiriTools({
    dir: options.dir,
    depth: 0,
    isClone: false,
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
    onHarvest: () => {
      // Unreachable: handleHarvest checks context.isClone (false here, the
      // parent is never a clone) and returns an error result before ever
      // calling this callback. Present only to satisfy the type.
      throw new Error("mekiri-host: onHarvest should never be invoked at the parent (isClone: false)");
    },
  });
```

- [ ] **Step 2: Run the type checker to confirm the call site is fixed**

Run: `cd packages/mekiri-host && npx tsc --noEmit -p tsconfig.json`
Expected: clean, no errors (including the one noted as expected-but-unfixed in Tasks 3 and 4).

- [ ] **Step 3: Write the live end-to-end smoke test**

Add to `packages/mekiri-host/test/repl.smoke.test.ts` (append):

```ts
import { runClone } from "../src/clone.js";

// Real, billed end-to-end proof that sprout/harvest work from the actual
// parent code path (runRepl's own createMekiriTools wiring), not just via
// tools.test.ts's direct handleSprout calls. Deliberately drives runClone
// directly with the real createMekiriTools (rather than spinning up a full
// runRepl() with readline, which has no clean way to await from a test) —
// this still exercises the real depth:0/isClone:false parent context
// shape wired in Step 1, just without the readline/stdin layer runRepl
// adds on top.
import { createMekiriTools } from "../src/tools.js";

describe("mekiri-host live smoke test: sprout/harvest end-to-end from the parent's real tool wiring", () => {
  it("a clone can prune its own failed hypothesis, then harvest the successful path", async () => {
    const dir = process.cwd();
    let parentSessionId: string | undefined;

    const parentTools = createMekiriTools({
      dir,
      depth: 0,
      isClone: false,
      getSessionId: () => {
        if (!parentSessionId) throw new Error("no parent session id yet");
        return parentSessionId;
      },
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("parent should not prune itself in this test");
      },
      onHarvest: () => {
        throw new Error("parent should never receive a harvest call directly");
      },
    });

    // Establish a real parent session id the same way repl.ts does: run one
    // trivial turn and read session_id off the system/init message.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createInputQueue } = await import("../src/inputQueue.js");
    const { buildQueryOptions } = await import("../src/permissions.js");
    const seed = createInputQueue();
    seed.push("Reply with exactly one word: ok");
    seed.close();
    const seedQuery = query({ prompt: seed.iterable, options: buildQueryOptions({ resume: undefined, cwd: dir, mcpServers: { mekiri: parentTools } }) });
    for await (const message of seedQuery) {
      if (message.type === "system" && message.subtype === "init") {
        parentSessionId = message.session_id;
      }
    }
    expect(parentSessionId).toBeTruthy();

    // Now drive a real sprout via the same handleSprout the sprout tool
    // calls, through the real parent context shape.
    const { handleSprout } = await import("../src/tools.js");
    const output = await handleSprout(
      {
        dir,
        depth: 0,
        isClone: false,
        getSessionId: () => parentSessionId as string,
        getTranscript: () => [],
        onSwitch: () => {},
        onHarvest: () => {},
      },
      {
        task:
          "First, state the sentence: Trying hypothesis A now, this is a test. Then immediately call the mcp__mekiri__prune tool with quote set to the verbatim text 'Trying hypothesis A now, this is a test', note_type 'death_reload', fruit set to {\"tried\": \"hypothesis A\", \"ruled_out\": \"A does not apply here, this is a scripted test\"}, and keep_code true. After the prune call returns you will be in a fresh continuation of this same task — at that point call the mcp__mekiri__harvest tool with result set to exactly the string PRUNE_THEN_HARVEST_OK and nothing else.",
      },
    );

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.result).toBe("PRUNE_THEN_HARVEST_OK");
  }, 90_000);
});
```

- [ ] **Step 4: Run the new test**

Run: `cd packages/mekiri-host && npx vitest run test/repl.smoke.test.ts -t "sprout/harvest end-to-end"`
Expected: PASS (1 test) — this is the plan's most expensive and highest-risk live test, exercising a real nested `prune`-inside-`sprout` round trip, the specific scenario called out as the motivating use case for this whole feature. If the model doesn't reliably follow the scripted instruction (e.g., it prunes with a slightly different quote, or skips straight to harvest), tighten the prompt's wording rather than loosening the test's assertions — but if you hit a **structural** failure (the clone's `prune` call doesn't actually re-establish a working continuation, or the harvest call after a prune-inside-clone doesn't reach the same `runClone` loop correctly), STOP and report BLOCKED with the specifics: that would mean the core mechanism this task exists to prove doesn't actually work, which is exactly the kind of finding this plan expects you to surface, not paper over.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (33 tests: 32 from Tasks 1-4 + 1 new).

- [ ] **Step 6: Manually dogfood the full prune-inside-sprout scenario**

This is not an automated test — it's the real dogfooding step, per the `feedback_dogfood_asap` memory and per the user's own explicit motivating example for this feature (hypothesis A fails and rolls back, B and C likewise, D succeeds, and the parent only ever sees the clean path in the harvest result):

```bash
cd packages/mekiri-host && npx tsx src/index.ts --dir /home/pol/dev/rollback
```

Ask it to sprout a clone to investigate something real in this repo where you expect at least one dead end, and have the clone `prune` itself after each false start before trying the next approach. Confirm: the parent session stays completely unaware of the clone's internal back-and-forth (only the final `harvest` result appears in the parent's `sprout` tool_result), a new session file exists for the clone under `~/.claude/projects/<sanitized-dir>/`, and `.mekiri/audit.jsonl` has both the clone's internal `prune` entries and one `sprout` entry from the parent. Report what happened — fix directly or capture a properly-scoped follow-up for anything broken, per the established policy for this project.

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-host/src/repl.ts packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "feat(mekiri-host): wire sprout/harvest into the parent REPL; add live end-to-end smoke test"
```

---

## Definition of Done

- `cd packages/mekiri-host && npx vitest run` passes with 0 failures (33 tests: the 25 already shipped + 8 new across this plan).
- `npx tsc --noEmit -p packages/mekiri-host/tsconfig.json` clean.
- `npx tsx packages/mekiri-host/src/index.ts --dir <path>` — from the real parent REPL, `sprout` forks a warm clone, the clone can `prune` itself internally (including rolling back failed hypotheses) as many times as it needs, and `harvest` returns the clone's distilled result to the parent synchronously, with the parent's own session untouched throughout.
- No task left a placeholder, a skipped test, or a TODO comment.
- Manual dogfooding (Task 5, Step 6) has actually happened at least once, specifically exercising a clone that prunes itself at least once before harvesting, with any findings fixed directly or captured as a follow-up.
