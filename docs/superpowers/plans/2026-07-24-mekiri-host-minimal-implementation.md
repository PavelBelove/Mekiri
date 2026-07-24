# Mekiri Host (Minimal, prune-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal, real, dogfoodable `mekiri-host`: a terminal REPL backed by `@anthropic-ai/claude-agent-sdk`'s `query()`, with a real `prune` tool wired in, that can actually cut a live session's dirty tail and continue from a distilled note — no ACP, no `sprout`.

**Architecture:** A small TypeScript package (`packages/mekiri-host`) depending on `mekiri-core` (the workspace package already built and reviewed) and the Agent SDK directly. Four building blocks: a controllable input queue that turns typed lines into the SDK's streaming-input format, a live-transcript adapter that turns the SDK's real-time message stream into the `RawLine[]` shape `mekiri-core`'s `findBoundary` already knows how to search, an in-process `prune` MCP tool wired to `mekiri-core`'s `validateFruit`/`findBoundary`/`createBranch`, and a REPL loop that runs one `query()` at a time and swaps to a freshly-forked session when `prune` fires.

**Tech Stack:** TypeScript, Node.js 24, npm workspaces, Vitest, Zod, `@anthropic-ai/claude-agent-sdk`, `tsx` (dev-only, to run the REPL without a build step), `mekiri-core` (workspace dependency).

## Global Constraints

- No ACP, no `sprout`/`harvest`, no `configure_mekiri` in this iteration — see `docs/superpowers/specs/2026-07-24-mekiri-host-minimal-design.md` §1/§4 for what's explicitly deferred.
- The live-transcript adapter must produce `RawLine`-shaped objects that `mekiri-core`'s `findBoundary`/`findLastCompactBoundaryIndex` can consume **unmodified** — do not fork or duplicate that matching logic in this package.
- `parentUuid` does not need to be a real parent chain in the adapter's output — neither `findBoundary` nor `findLastCompactBoundaryIndex` reads it (verified against `mekiri-core`'s actual implementation during design).
- Everything that reaches the main `query()` stream is main-chain, non-sidechain content — the adapter always sets `isSidechain: false`.
- `removedBranchLength`/`fruitLength` passed to `createBranch` must both be **character-length proxies** (matching `mekiri-core`'s established convention after its own Task 9 fix) — never a line count for one side and a character count for the other.
- Real, unmocked `forkSession` (via `mekiri-core`'s `createBranch`) is a local file operation, not a network call — safe to exercise in tests. Real `query()` calls DO cost tokens — keep automated live tests to the minimum the design spec calls for (1-2 cheap smoke tests); everything else is manual dogfooding per the user's explicit priority (see memory `feedback_dogfood_asap`).
- Session ids passed to `createBranch`/`forkSession` must be real UUID-format strings (verified during `mekiri-core` Task 7 against the compiled SDK) — this is automatically satisfied in this package since real session ids always come from the SDK's own `system`/`init` message, never a hand-written fixture, except in tests that need a fixture session file (follow `mekiri-core`'s `test/branch.test.ts` pattern: literal UUID-shaped strings, `CLAUDE_CONFIG_DIR` + `dir` filesystem convention).

## A note on empirical uncertainty in this plan

Some of the SDK surface this plan relies on was verified directly against the installed `@anthropic-ai/claude-agent-sdk@0.3.218`'s `.d.ts` (types, field names, method signatures) but the **runtime behavior** of a few pieces — whether `Query.return()` fully tears down whatever process/resources the SDK holds for a query, whether `system`/`init` reliably fires on every `query()` call including resumed ones, whether the streaming-input `AsyncIterable<SDKUserMessage>` shape needs anything beyond what's shown below — was not empirically exercised while writing this plan (that would have spent the user's API budget during planning, which wasn't authorized). Task 5, which is where these assumptions get exercised for real, has explicit instructions to verify and adjust, mirroring how `mekiri-core`'s Task 7 handled a similar situation with `forkSession`.

---

### Task 1: Package scaffold

**Files:**
- Create: `packages/mekiri-host/package.json`
- Create: `packages/mekiri-host/tsconfig.json`
- Create: `packages/mekiri-host/vitest.config.ts`
- Create: `packages/mekiri-host/src/index.ts`
- Test: `packages/mekiri-host/test/sanity.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task of this plan). Depends on `mekiri-core` (already built, exports `validateFruit`, `findBoundary`, `findLastCompactBoundaryIndex`, `createBranch`, `RawLine`, `NoteType`, `BranchType`, etc. — see `packages/mekiri-core/src/index.ts`).
- Produces: `PACKAGE_NAME` constant, working toolchain — used by no later task directly, pure smoke check (same pattern as `mekiri-core`'s Task 1).

- [ ] **Step 1: Create `packages/mekiri-host/package.json`**

```json
{
  "name": "mekiri-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "start": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "mekiri-core": "*",
    "@anthropic-ai/claude-agent-sdk": "^0.3.218",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create `packages/mekiri-host/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/mekiri-host/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies from repo root**

Run: `npm install`
Expected: no errors. This wires the `mekiri-core` workspace dependency (npm workspaces resolves `"mekiri-core": "*"` to `packages/mekiri-core` automatically since it's a sibling workspace) and installs `tsx`.

- [ ] **Step 5: Write the failing sanity test**

Create `packages/mekiri-host/test/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package sanity", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-host");
  });

  it("can import mekiri-core's public API", async () => {
    const core = await import("mekiri-core");
    expect(typeof core.findBoundary).toBe("function");
    expect(typeof core.createBranch).toBe("function");
    expect(typeof core.validateFruit).toBe("function");
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: FAIL — `src/index.ts` doesn't exist yet.

- [ ] **Step 7: Create the minimal implementation**

Create `packages/mekiri-host/src/index.ts`:

```ts
export const PACKAGE_NAME = "mekiri-host";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/mekiri-host/package.json packages/mekiri-host/tsconfig.json packages/mekiri-host/vitest.config.ts packages/mekiri-host/src/index.ts packages/mekiri-host/test/sanity.test.ts
git commit -m "chore: scaffold mekiri-host package"
```

---

### Task 2: Controllable input queue

**Files:**
- Create: `packages/mekiri-host/src/inputQueue.ts`
- Test: `packages/mekiri-host/test/inputQueue.test.ts`

**Interfaces:**
- Consumes: `SDKUserMessage` type from `@anthropic-ai/claude-agent-sdk`.
- Produces: `createInputQueue(): { iterable: AsyncIterable<SDKUserMessage>; push: (text: string) => void; close: () => void }` — consumed by Task 5's REPL loop, which needs one long-lived `AsyncIterable<SDKUserMessage>` per `query()` call that it can both feed from stdin AND seed with a synthetic message (the post-`prune` injected note) without restarting.

**Background:** `query()`'s `prompt` option accepts either a plain string (one-shot) or `AsyncIterable<SDKUserMessage>` (streaming-input mode, which keeps one `query()` call open across many user turns and is required for `Query.interrupt()`/other control methods to work — confirmed in the SDK's own `.d.ts` comments: "Only available in streaming input mode"). The REPL needs exactly this: read stdin lines into the SAME session across turns, but also be able to push one synthetic message (the pruned note) as the very first input to a *new* `query()` call after switching sessions. This task builds that queue as a standalone, fully unit-testable primitive with no SDK/network dependency beyond the `SDKUserMessage` type.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-host/test/inputQueue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createInputQueue } from "../src/inputQueue.js";

describe("createInputQueue", () => {
  it("yields pushed messages in order", async () => {
    const { iterable, push, close } = createInputQueue();
    push("first");
    push("second");
    close();

    const results: string[] = [];
    for await (const msg of iterable) {
      results.push(msg.message.content as string);
    }
    expect(results).toEqual(["first", "second"]);
  });

  it("yields a message pushed after the consumer is already waiting", async () => {
    const { iterable, push, close } = createInputQueue();
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();

    push("delayed");
    const result = await pending;

    expect(result.done).toBe(false);
    expect(result.value?.message.content).toBe("delayed");
    close();
  });

  it("stamps origin as human on every message", async () => {
    const { iterable, push, close } = createInputQueue();
    push("hi");
    close();

    for await (const msg of iterable) {
      expect(msg.origin).toEqual({ kind: "human" });
      expect(msg.type).toBe("user");
      expect(msg.parent_tool_use_id).toBeNull();
    }
  });

  it("ends iteration when closed with no pending messages", async () => {
    const { iterable, close } = createInputQueue();
    close();
    const iterator = iterable[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("ends iteration when closed while a consumer is waiting", async () => {
    const { iterable, close } = createInputQueue();
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    close();
    const result = await pending;
    expect(result.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/inputQueue.test.ts`
Expected: FAIL — `src/inputQueue.ts` doesn't exist yet.

- [ ] **Step 3: Write `inputQueue.ts`**

Create `packages/mekiri-host/src/inputQueue.ts`:

```ts
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface InputQueue {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (text: string) => void;
  close: () => void;
}

function toUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

export function createInputQueue(): InputQueue {
  const queue: string[] = [];
  let waitingResolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;

  function push(text: string): void {
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve({ value: toUserMessage(text), done: false });
      return;
    }
    queue.push(text);
  }

  function close(): void {
    closed = true;
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: toUserMessage(queue.shift() as string), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waitingResolve = resolve;
          });
        },
      };
    },
  };

  return { iterable, push, close };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/inputQueue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (7 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/inputQueue.ts packages/mekiri-host/test/inputQueue.test.ts
git commit -m "feat(mekiri-host): add controllable input queue for streaming-input query()"
```

---

### Task 3: Live-transcript adapter

**Files:**
- Create: `packages/mekiri-host/src/liveTranscript.ts`
- Test: `packages/mekiri-host/test/liveTranscript.test.ts`

**Interfaces:**
- Consumes: `RawLine` type from `mekiri-core`; `SDKMessage`/`SDKAssistantMessage`/`SDKCompactBoundaryMessage` types from `@anthropic-ai/claude-agent-sdk`.
- Produces: `createLiveTranscript(): { push(message: SDKMessage): void; getLines(): RawLine[] }` — consumed by Task 4's `prune` tool (to search for the boundary quote) and Task 5's REPL loop (to feed it every message as it streams, and to reset it on session switch).

**Background:** verified directly against the installed SDK's `.d.ts`: `SDKAssistantMessage` has `type: 'assistant'`, `uuid: UUID`, and `message: BetaMessage` (Anthropic's own Messages-API message shape, whose `content` blocks already have `{type, text}` for text blocks — structurally compatible with what `mekiri-core`'s `findBoundary` reads). Compaction shows up as `SDKCompactBoundaryMessage`: `{type: 'system', subtype: 'compact_boundary', uuid, compact_metadata: {...}}` — translate this into the same two-line `{type:"system", compactMetadata}` + `{type:"user", isCompactSummary:true, uuid}` pair that `mekiri-core`'s `findLastCompactBoundaryIndex` already knows how to find (it was built against real jsonl transcripts that encode compaction exactly this way).

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-host/test/liveTranscript.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createLiveTranscript } from "../src/liveTranscript.js";
import { findBoundary } from "mekiri-core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function fakeAssistantMessage(uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "session-under-test",
    parent_tool_use_id: null,
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage;
}

function fakeCompactBoundary(uuid: string): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    session_id: "session-under-test",
    compact_metadata: { trigger: "auto", pre_tokens: 1000 },
  } as unknown as SDKMessage;
}

describe("createLiveTranscript", () => {
  it("turns an assistant message into a searchable RawLine", () => {
    const transcript = createLiveTranscript();
    transcript.push(fakeAssistantMessage("11111111-1111-4111-8111-111111111111", "Reading the logs now to find the root cause."));

    const boundary = findBoundary(transcript.getLines(), "Reading the logs now");
    expect(boundary).toEqual({ status: "ok", uuid: "11111111-1111-4111-8111-111111111111" });
  });

  it("translates a compact boundary message into a two-line pair findLastCompactBoundaryIndex recognizes", () => {
    const transcript = createLiveTranscript();
    transcript.push(fakeAssistantMessage("22222222-2222-4222-8222-222222222222", "Before the compaction, this text appears."));
    transcript.push(fakeCompactBoundary("33333333-3333-4333-8333-333333333333"));
    transcript.push(fakeAssistantMessage("44444444-4444-4444-8444-444444444444", "After the compaction, fresh work begins."));

    const boundary = findBoundary(transcript.getLines(), "Before the compaction, this text appears");
    expect(boundary).toEqual({ status: "in_compacted_zone", lastCompactUuid: "33333333-3333-4333-8333-333333333333" });

    const freshBoundary = findBoundary(transcript.getLines(), "After the compaction, fresh work begins");
    expect(freshBoundary).toEqual({ status: "ok", uuid: "44444444-4444-4444-8444-444444444444" });
  });

  it("ignores message types that carry no searchable text (e.g. a bare system init message)", () => {
    const transcript = createLiveTranscript();
    transcript.push({ type: "system", subtype: "init", session_id: "x", uuid: "u" } as unknown as SDKMessage);
    expect(transcript.getLines()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/liveTranscript.test.ts`
Expected: FAIL — `src/liveTranscript.ts` doesn't exist yet.

- [ ] **Step 3: Write `liveTranscript.ts`**

Create `packages/mekiri-host/src/liveTranscript.ts`:

```ts
import type { RawLine } from "mekiri-core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface LiveTranscript {
  push(message: SDKMessage): void;
  getLines(): RawLine[];
}

export function createLiveTranscript(): LiveTranscript {
  const lines: RawLine[] = [];

  function push(message: SDKMessage): void {
    if (message.type === "assistant") {
      lines.push({
        type: "assistant",
        uuid: message.uuid,
        parentUuid: null,
        isSidechain: false,
        message: {
          role: "assistant",
          content: message.message.content as unknown as Array<{ type: string; text?: string }>,
        },
      });
      return;
    }

    if (message.type === "system" && (message as { subtype?: string }).subtype === "compact_boundary") {
      const compactMessage = message as { uuid: string; compact_metadata: unknown };
      lines.push({ type: "system", compactMetadata: compactMessage.compact_metadata });
      lines.push({
        type: "user",
        uuid: compactMessage.uuid,
        parentUuid: null,
        isSidechain: false,
        isCompactSummary: true,
      });
      return;
    }
  }

  function getLines(): RawLine[] {
    return lines;
  }

  return { push, getLines };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/liveTranscript.test.ts`
Expected: PASS (3 tests). If TypeScript complains about the `message.message.content` cast or the discriminated union narrowing on `message.type === "assistant"`, adjust the cast (the intent is: `BetaMessage.content`'s text blocks are structurally `{type:"text", text:string}`, compatible with what `mekiri-core`'s `RawLine.message.content` expects — a cast, not a redesign, should resolve it).

- [ ] **Step 5: Run the full suite**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (10 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/liveTranscript.ts packages/mekiri-host/test/liveTranscript.test.ts
git commit -m "feat(mekiri-host): adapt the live query() message stream into mekiri-core's RawLine shape"
```

---

### Task 4: `prune` tool

**Files:**
- Create: `packages/mekiri-host/src/tools.ts`
- Test: `packages/mekiri-host/test/tools.test.ts`

**Interfaces:**
- Consumes: `validateFruit`, `findBoundary`, `createBranch` from `mekiri-core`; `RawLine` type; `tool`/`createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`; `LiveTranscript` (Task 3, via its `getLines()` shape, not the module directly — the tool only needs a function returning `RawLine[]`).
- Produces: `handlePrune(context: MekiriToolsContext, args: PruneArgs): Promise<PruneToolResult>` (directly unit-testable, no MCP machinery needed) and `createMekiriTools(context: MekiriToolsContext): McpSdkServerConfigWithInstance` (wires `handlePrune` into a real `tool()`/`createSdkMcpServer()` pair) — both consumed by Task 5's REPL loop.

**Background:** `createBranch`'s `removedBranchLength` must be a character-length proxy (Global Constraints) — computed here as the JSON-serialized length of the transcript lines *after* the boundary line, not a line count.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-host/test/tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlePrune } from "../src/tools.js";
import type { RawLine } from "mekiri-core";

// Session-file test helpers mirroring mekiri-core's test/helpers/sessionFile.ts
// (same CLAUDE_CONFIG_DIR + dir + slash-to-dash sanitization convention,
// verified during mekiri-core's Task 7 against the compiled SDK).
function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}
async function writeSessionFile(configDir: string, dir: string, sessionId: string, lines: RawLine[]): Promise<void> {
  const { promises: fs } = await import("node:fs");
  const filePath = path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const U1_UUID = "77777777-7777-4777-8777-777777777777";
const A1_UUID = "88888888-8888-4888-8888-888888888888";
const A2_UUID = "99999999-9999-4999-8999-999999999999";

describe("handlePrune", () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let switchCalls: Array<{ newSessionId: string; injectText: string }>;
  let transcriptLines: RawLine[];

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    switchCalls = [];

    transcriptLines = [
      { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Reading the logs now, this is the boundary." }] } },
      { type: "assistant", uuid: A2_UUID, parentUuid: A1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "More garbage after the boundary." }] } },
    ];
    await writeSessionFile(configDir, projectDir, SESSION_ID, transcriptLines);
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeContext() {
    return {
      dir: projectDir,
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId: string, injectText: string) => {
        switchCalls.push({ newSessionId, injectText });
      },
    };
  }

  it("prunes successfully, calls onSwitch with a new session id, and reports ok", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: { summary: "Found the cause, fixed it.", files_touched: [{ path: "src/foo.ts", change: "fix" }] },
      keep_code: true,
    });

    expect(result.isError).toBeFalsy();
    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).not.toBe(SESSION_ID);
    expect(switchCalls[0].injectText).toContain("Found the cause, fixed it.");
  });

  it("returns an error result and does not call onSwitch when fruit validation fails", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: {}, // missing required summary
      keep_code: true,
    });

    expect(result.isError).toBe(true);
    expect(switchCalls).toHaveLength(0);
  });

  it("reports not_found and does not call onSwitch when the quote doesn't match", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "this text does not appear anywhere in the transcript",
      note_type: "portal",
      fruit: { summary: "irrelevant" },
      keep_code: false,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("not_found");
    expect(switchCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: FAIL — `src/tools.ts` doesn't exist yet.

- [ ] **Step 3: Write `tools.ts`**

Create `packages/mekiri-host/src/tools.ts`:

```ts
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { validateFruit, findBoundary, createBranch } from "mekiri-core";
import type { RawLine, NoteType } from "mekiri-core";

export interface MekiriToolsContext {
  dir: string;
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
}

export interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

export interface PruneToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handlePrune(context: MekiriToolsContext, args: PruneArgs): Promise<PruneToolResult> {
  const validation = validateFruit({
    noteType: args.note_type,
    fruit: args.fruit,
    keepCode: args.keep_code,
  });
  if (!validation.ok) {
    return { content: [{ type: "text", text: `invalid fruit: ${validation.errors.join("; ")}` }], isError: true };
  }

  const transcript = context.getTranscript();
  const boundary = findBoundary(transcript, args.quote);
  if (boundary.status !== "ok") {
    return { content: [{ type: "text", text: JSON.stringify(boundary) }] };
  }

  const boundaryIndex = transcript.findIndex((line) => line.uuid === boundary.uuid);
  const removedLines = boundaryIndex >= 0 ? transcript.slice(boundaryIndex + 1) : [];
  const removedBranchLength = JSON.stringify(removedLines).length;
  const fruitLength = JSON.stringify(validation.fruit).length;

  const { newSessionId } = await createBranch({
    branchType: "prune",
    sessionId: context.getSessionId(),
    dir: context.dir,
    upToMessageId: boundary.uuid,
    noteType: args.note_type,
    removedBranchLength,
    fruitLength,
    auditProjectDir: context.dir,
  });

  const injectText = [
    "[branch_type:prune, branch archived, resuming from fruit]",
    JSON.stringify({ note_type: args.note_type, fruit: validation.fruit }, null, 2),
  ].join("\n");

  context.onSwitch(newSessionId, injectText);

  return { content: [{ type: "text", text: `ok: new_session_id=${newSessionId}` }] };
}

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
    (args) => handlePrune(context, args as PruneArgs),
  );

  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool] });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts`
Expected: PASS (3 tests). If the fixture session-file setup fails with an ENOENT/"session not found" style error, check `sanitizeDir` against a real entry under `~/.claude/projects/` on the machine running the test the same way `mekiri-core`'s Task 7 did — don't loosen the test assertions.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (13 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/tools.ts packages/mekiri-host/test/tools.test.ts
git commit -m "feat(mekiri-host): add the prune MCP tool wired to mekiri-core"
```

---

### Task 5: REPL loop, CLI entrypoint, and live smoke tests

**Files:**
- Create: `packages/mekiri-host/src/repl.ts`
- Modify: `packages/mekiri-host/src/index.ts`
- Test: `packages/mekiri-host/test/repl.smoke.test.ts`

**Interfaces:**
- Consumes: `createInputQueue` (Task 2), `createLiveTranscript` (Task 3), `createMekiriTools` (Task 4), `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `runRepl(options: ReplOptions): Promise<void>` — the actual CLI behavior; nothing later in this plan consumes it (this is the final task), but it's what the user runs directly (`npm start -- --dir /home/pol/dev/rollback [--resume <id>]`) to dogfood `prune`.

**Background — read before starting, this task carries the plan's real empirical risk:** the exact runtime behavior of `Query.return()` (does it cleanly release whatever resources the SDK holds for that query?), whether `system`/`init` fires on every `query()` call including ones with `resume` set, and the precise shape `@anthropic-ai/claude-agent-sdk` expects from a streaming-input `AsyncIterable<SDKUserMessage>` were verified against the installed SDK's type definitions while writing this plan, but **not exercised at runtime** (that would have spent API budget without authorization during planning). This task is where that gets tested for real, for the first time, with actual tokens. If any assumption below turns out wrong, fix the code to match reality and note what changed in your report — do not force the plan's literal text through if the SDK actually behaves differently.

- [ ] **Step 1: Write `repl.ts`**

Create `packages/mekiri-host/src/repl.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { createMekiriTools } from "./tools.js";

export interface ReplOptions {
  resumeSessionId?: string;
  dir: string;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  let currentInput = createInputQueue();
  let transcript = createLiveTranscript();
  let currentSessionId = options.resumeSessionId;
  let pendingSwitch: { newSessionId: string; injectText: string } | null = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => currentInput.push(line));

  const tools = createMekiriTools({
    dir: options.dir,
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
  });

  let running = true;
  while (running) {
    const q = query({
      prompt: currentInput.iterable,
      options: {
        resume: currentSessionId,
        cwd: options.dir,
        mcpServers: { mekiri: tools },
      },
    });

    for await (const message of q) {
      transcript.push(message);

      if (message.type === "system" && message.subtype === "init") {
        currentSessionId = message.session_id;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
      }

      if (pendingSwitch) {
        await q.return(undefined);
        break;
      }
    }

    if (pendingSwitch) {
      const { newSessionId, injectText } = pendingSwitch;
      pendingSwitch = null;
      currentSessionId = newSessionId;
      transcript = createLiveTranscript();
      currentInput = createInputQueue();
      currentInput.push(injectText);
      continue;
    }

    running = false;
  }

  rl.close();
}
```

- [ ] **Step 2: Wire the CLI entrypoint**

Modify `packages/mekiri-host/src/index.ts`:

```ts
export const PACKAGE_NAME = "mekiri-host";
export { runRepl } from "./repl.js";
export type { ReplOptions } from "./repl.js";

function parseArgs(argv: string[]): { resumeSessionId?: string; dir: string } {
  let resumeSessionId: string | undefined;
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) {
      resumeSessionId = argv[i + 1];
      i++;
    } else if (argv[i] === "--dir" && argv[i + 1]) {
      dir = argv[i + 1];
      i++;
    }
  }
  return { resumeSessionId, dir };
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const { runRepl } = await import("./repl.js");
  const { resumeSessionId, dir } = parseArgs(process.argv.slice(2));
  await runRepl({ resumeSessionId, dir });
}
```

- [ ] **Step 3: Write the live smoke tests**

Create `packages/mekiri-host/test/repl.smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInputQueue } from "../src/inputQueue.js";

// These tests make real, billed API calls. Keep them to the minimum needed
// to prove the wiring this task adds actually works end to end — everything
// beyond this is manual dogfooding per the design spec's explicit choice.
describe("mekiri-host live smoke test", () => {
  it("completes one real turn, captures a session id, and receives assistant text", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let sessionId: string | undefined;
    let sawAssistantText = false;

    const q = query({ prompt: iterable, options: { cwd: process.cwd() } });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantText).toBe(true);
  }, 60_000);

  it("resumes a session by id and the resumed query's init message reports the same session id", async () => {
    const first = createInputQueue();
    first.push("Reply with exactly one word: ok");
    first.close();

    let firstSessionId: string | undefined;
    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") firstSessionId = message.session_id;
    }
    expect(firstSessionId).toBeTruthy();

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    const q2 = query({ prompt: second.iterable, options: { resume: firstSessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") secondSessionId = message.session_id;
    }

    expect(secondSessionId).toBe(firstSessionId);
  }, 60_000);
});
```

- [ ] **Step 4: Run the smoke tests**

Run: `cd packages/mekiri-host && npx vitest run test/repl.smoke.test.ts`
Expected: PASS (2 tests) — this spends a small amount of real API budget; that's expected and authorized by the design spec's explicit test-budget choice. If either test fails, this is exactly the empirical-uncertainty situation flagged in this task's Background section — investigate what the SDK actually does (add temporary logging of raw messages if needed) and fix `repl.ts`/`inputQueue.ts` to match reality, rather than adjusting the test to tolerate broken behavior.

- [ ] **Step 5: Manually verify the REPL runs and `prune` works end to end**

This is not an automated test — it's the actual dogfooding step:

```bash
cd packages/mekiri-host && npx tsx src/index.ts --dir /home/pol/dev/rollback
```

Have a short real conversation that reads something moderately verbose (e.g. ask it to read this plan file back), then ask it to call `prune` to close out that side-reading with a `portal` note. Confirm: the tool call succeeds, the terminal keeps working afterward (new session, same terminal), and a look at `~/.claude/projects/<sanitized-dir>/` shows a new session file alongside the untouched original. Report what happened (including anything broken) rather than silently moving on — per the `feedback_dogfood_asap` memory, fix small issues directly or add a properly-scoped follow-up task/finding for anything bigger.

- [ ] **Step 6: Run the full suite one final time**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS (15 tests total: 13 from Tasks 1-4 + 2 smoke tests).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-host/src/repl.ts packages/mekiri-host/src/index.ts packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "feat(mekiri-host): add REPL loop with session-switching on prune, and CLI entrypoint"
```

---

## Definition of Done

- `cd packages/mekiri-host && npx vitest run` passes with 0 failures (15 tests: 13 free/local + 2 cheap live smoke tests).
- `npx tsx packages/mekiri-host/src/index.ts --dir <path>` runs an interactive REPL that can hold a real conversation and, when the model calls `prune`, actually forks the session file and continues the same terminal session from the distilled note.
- No task left a placeholder, a skipped test, or a TODO comment.
- Manual dogfooding (Task 5, Step 5) has actually happened at least once, with any findings either fixed directly or captured as a follow-up.
