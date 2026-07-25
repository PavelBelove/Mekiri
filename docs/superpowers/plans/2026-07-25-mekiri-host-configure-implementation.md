# Mekiri Host `configure_mekiri` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `configure_mekiri` MCP tool to `mekiri-host` that lets an agent patch its own `.mekiri/config.json` at runtime (`sprout.depth_limit`, `sprout.parallelism`, `sprout.wait_mode`, `priorities.token_efficiency`), unblocking the `mekiri-tuning` skill (next iteration).

**Architecture:** `handleConfigure` is a thin orchestration of three already-shipped `mekiri-core` primitives — `loadConfig` (read current), `applyConfigPatch` (deep-merge + full-schema validation), `saveConfig` (persist on success) — plus an audit-log write via the already-typed `ConfigureAuditEntry`. No new `mekiri-core` code is needed. The tool is registered unconditionally in `createMekiriTools`, exactly like `prune`/`sprout`/`harvest`, so it's available identically to the parent and to clones at any depth (no `isClone` check) — there's no structural reason to forbid a clone from adjusting shared config, and the audit log's `reason` field already captures who changed what and why.

**Tech Stack:** TypeScript, Node.js, Vitest, Zod, `@anthropic-ai/claude-agent-sdk`, `mekiri-core` (`loadConfig`/`saveConfig`/`applyConfigPatch`/`appendAuditEntry`/`ConfigureAuditEntry`, all already shipped).

## Global Constraints

- `configure_mekiri` is available everywhere — parent and clones at any depth, no `isClone` restriction. (design spec §2)
- The tool's `patch` argument is a free-form object at the Zod-schema level (`z.record(z.string(), z.unknown())`); real structural validation happens inside `applyConfigPatch` against `MekiriConfigSchema`, not duplicated at the tool-schema level. (design spec §3)
- An invalid patch returns `{status: "invalid", errors}` as an `isError: true` tool result and must **not** write to disk and must **not** append an audit entry. (design spec §2 step 3)
- A valid patch is persisted via `saveConfig`, then recorded via `appendAuditEntry` with `{event: "configure_mekiri", timestamp, reason: args.reason, patch: args.patch}` (the `ConfigureAuditEntry` type already exported by `mekiri-core`). (design spec §2 step 4)
- `reason` is a required string argument, always recorded in the audit log. (design spec §3)
- Live-test budget: exactly one minimal live smoke test proving a real model finds and calls the tool by name through the full stack; everything else is deterministic unit tests plus manual dogfooding. (design spec §4)

---

### Task 1: `handleConfigure` handler + tool registration

**Files:**
- Modify: `packages/mekiri-host/src/tools.ts`
- Test: `packages/mekiri-host/test/tools.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `applyConfigPatch` from `"mekiri-core"` (only `loadConfig` is currently imported in `tools.ts`; add `saveConfig`, `applyConfigPatch`), and the `ConfigureAuditEntry` type (add to the existing type-only import that already has `SproutAuditEntry`). `appendAuditEntry` is already imported.
- Produces: `export interface ConfigureArgs { patch: Record<string, unknown>; reason: string }` and `export async function handleConfigure(context: MekiriToolsContext, args: ConfigureArgs): Promise<PruneToolResult>`, plus a `configure_mekiri` tool added to the array passed to `createSdkMcpServer` in `createMekiriTools`. `PruneToolResult` (already defined in `tools.ts`) is reused as the return type, matching every other handler in the file.

- [ ] **Step 1: Write the failing unit tests**

Add to `packages/mekiri-host/test/tools.test.ts`. First, change the `mekiri-core` import on line 8 from:

```ts
import { readAuditLog } from "mekiri-core";
```

to:

```ts
import { readAuditLog, loadConfig, defaultConfig } from "mekiri-core";
```

Also change line 5 of the same file from:

```ts
import { handlePrune, handleHarvest, handleSprout } from "../src/tools.js";
```

to:

```ts
import { handlePrune, handleHarvest, handleSprout, handleConfigure } from "../src/tools.js";
```

and line 6 from:

```ts
import type { HarvestArgs, SproutArgs } from "../src/tools.js";
```

to:

```ts
import type { HarvestArgs, SproutArgs, ConfigureArgs } from "../src/tools.js";
```

Then add a new `describe` block at the end of the file, after the closing of `describe("handleSprout", ...)`:

```ts
describe("handleConfigure", () => {
  let configureProjectDir: string;

  beforeEach(async () => {
    configureProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-configure-project-"));
  });

  afterEach(async () => {
    await rm(configureProjectDir, { recursive: true, force: true });
  });

  function makeContext() {
    return {
      dir: configureProjectDir,
      depth: 0,
      isClone: false,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000096",
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("onSwitch should not be called from a configure test");
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from a configure test");
      },
    };
  }

  it("applies a valid patch, persists it to disk, and records an audit entry", async () => {
    const args: ConfigureArgs = { patch: { sprout: { depth_limit: 2 } }, reason: "widen depth for this task" };

    const output = await handleConfigure(makeContext(), args);

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.config.sprout.depth_limit).toBe(2);

    const persisted = await loadConfig(configureProjectDir);
    expect(persisted.sprout.depth_limit).toBe(2);

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("configure_mekiri");
    if (log[0].event === "configure_mekiri") {
      expect(log[0].reason).toBe("widen depth for this task");
      expect(log[0].patch).toEqual({ sprout: { depth_limit: 2 } });
    }
  });

  it("returns an error result, does not persist, and does not record an audit entry when the patch is invalid", async () => {
    const args: ConfigureArgs = { patch: { sprout: { depth_limit: -1 } }, reason: "should be rejected" };

    const output = await handleConfigure(makeContext(), args);

    expect(output.isError).toBe(true);

    const persisted = await loadConfig(configureProjectDir);
    expect(persisted).toEqual(defaultConfig());

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(0);
  });

  it("deep-merges a patch, leaving unrelated fields untouched", async () => {
    await handleConfigure(makeContext(), { patch: { sprout: { depth_limit: 3 } }, reason: "first change" });

    const output = await handleConfigure(makeContext(), {
      patch: { priorities: { token_efficiency: "aggressive" } },
      reason: "second change",
    });

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.config.priorities.token_efficiency).toBe("aggressive");
    expect(parsed.config.sprout.depth_limit).toBe(3);

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts -t handleConfigure`
Expected: FAIL — `handleConfigure` is not exported from `../src/tools.js` (compile error).

- [ ] **Step 3: Implement `handleConfigure` in `tools.ts`**

Change the `mekiri-core` value import on line 5 of `packages/mekiri-host/src/tools.ts` from:

```ts
import { validateFruit, findBoundary, createBranch, loadConfig, appendAuditEntry } from "mekiri-core";
```

to:

```ts
import { validateFruit, findBoundary, createBranch, loadConfig, saveConfig, applyConfigPatch, appendAuditEntry } from "mekiri-core";
```

And change the type-only import on line 6 from:

```ts
import type { RawLine, NoteType, CreateBranchArgs, CreateBranchResult, SproutAuditEntry } from "mekiri-core";
```

to:

```ts
import type { RawLine, NoteType, CreateBranchArgs, CreateBranchResult, SproutAuditEntry, ConfigureAuditEntry } from "mekiri-core";
```

Then add this after `handleSprout` (after the closing `}` that ends the `handleSprout` function, before `export function createMekiriTools`):

```ts
export interface ConfigureArgs {
  patch: Record<string, unknown>;
  reason: string;
}

export async function handleConfigure(context: MekiriToolsContext, args: ConfigureArgs): Promise<PruneToolResult> {
  const current = await loadConfig(context.dir);
  const result = applyConfigPatch(current, args.patch);
  if (result.status === "invalid") {
    return { content: [{ type: "text", text: `invalid config patch: ${result.errors.join("; ")}` }], isError: true };
  }

  await saveConfig(context.dir, result.config);

  const auditEntry: ConfigureAuditEntry = {
    event: "configure_mekiri",
    timestamp: new Date().toISOString(),
    reason: args.reason,
    patch: args.patch,
  };
  await appendAuditEntry(context.dir, auditEntry);

  return { content: [{ type: "text", text: JSON.stringify({ status: "ok", config: result.config }) }] };
}
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts -t handleConfigure`
Expected: PASS (3/3)

- [ ] **Step 5: Register the tool in `createMekiriTools`**

In `packages/mekiri-host/src/tools.ts`, inside `createMekiriTools`, after the `sproutTool` definition and before the `return createSdkMcpServer(...)` line, add:

```ts
  const configureTool = tool(
    "configure_mekiri",
    "Patch Mekiri's own runtime configuration (.mekiri/config.json): sprout.depth_limit, sprout.parallelism, sprout.wait_mode, priorities.token_efficiency. The patch is deep-merged with the current config and validated as a whole; an invalid patch is rejected with no changes made. Available to the parent and to clones at any depth.",
    {
      patch: z.record(z.string(), z.unknown()).describe("Partial config object, deep-merged with the current config"),
      reason: z.string().describe("Why this change is being made -- recorded in the audit log"),
    },
    async (args) => (await handleConfigure(context, args as ConfigureArgs)) as CallToolResult,
  );
```

Then change the `return createSdkMcpServer(...)` line from:

```ts
  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool, sproutTool, harvestTool] });
```

to:

```ts
  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool, sproutTool, harvestTool, configureTool] });
```

- [ ] **Step 6: Run the full mekiri-host test suite (excluding live tests) to check for regressions**

Run: `cd packages/mekiri-host && npx vitest run test/tools.test.ts test/inputQueue.test.ts test/liveTranscript.test.ts test/sanity.test.ts`
Expected: PASS, all tests green (this excludes `repl.smoke.test.ts`, `clone.smoke.test.ts`, and `tools.forkRace.test.ts`, which make real API calls or are covered by Task 2).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-host/src/tools.ts packages/mekiri-host/test/tools.test.ts
git commit -m "feat(mekiri-host): add configure_mekiri tool for runtime config patching"
```

---

### Task 2: Live smoke test proving `configure_mekiri` is discoverable and callable end to end

**Files:**
- Modify: `packages/mekiri-host/test/repl.smoke.test.ts`

**Interfaces:**
- Consumes: `createMekiriTools`, `canUseTool` (already imported in this file), plus `loadConfig`, `readAuditLog` from `"mekiri-core"` (not yet imported in this file — add them).
- Produces: nothing new consumed by later tasks — this is the plan's final task.

**Background:** Every other tool (`prune`, `sprout`) has exactly one live test in this file proving a real model can find and call it by its `mcp__mekiri__` name through the actual `createMekiriTools` + `canUseTool` wiring, per the project's live-test-budget policy (unit tests cover logic; one live test per tool proves the wiring; everything else is manual dogfooding). This task adds the equivalent for `configure_mekiri`. Unlike the `prune` wiring test, this one needs no seeded session file or transcript — `configure_mekiri` doesn't read the transcript, so a fresh first turn (no `resume`) against an isolated temp project directory is enough.

- [ ] **Step 1: Add the live smoke test**

In `packages/mekiri-host/test/repl.smoke.test.ts`, change the `mekiri-core` type-only import on line 10 from:

```ts
import type { RawLine } from "mekiri-core";
```

to:

```ts
import { loadConfig, readAuditLog } from "mekiri-core";
import type { RawLine } from "mekiri-core";
```

Then add this new `describe` block at the end of the file:

```ts
describe("mekiri-host live smoke test: configure_mekiri tool wiring", () => {
  it("a real model turn that calls configure_mekiri completes and persists the patched config", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-configure-smoke-"));

    try {
      const tools = createMekiriTools({
        dir: projectDir,
        depth: 0,
        isClone: false,
        getSessionId: () => "unused-in-this-test",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("onSwitch should not be called from a configure smoke test");
        },
        onHarvest: () => {
          throw new Error("onHarvest should not be called from a configure smoke test");
        },
      });

      const { iterable, push, close } = createInputQueue();
      push(
        [
          "Call the configure_mekiri tool (mcp__mekiri__configure_mekiri) right now, in this turn, with exactly these arguments and no others:",
          'patch: {"priorities": {"token_efficiency": "aggressive"}}',
          'reason: "smoke test"',
          "The mcp__mekiri__configure_mekiri tool is already directly available to you -- do not use ToolSearch or any other lookup tool first, and do not call any other tool. Make mcp__mekiri__configure_mekiri your first and only tool call, immediately. Do not ask for permission or confirmation, and do not explain what you are about to do first -- just make the tool call.",
        ].join("\n"),
      );
      close();

      let sawToolResult = false;

      const q = query({
        prompt: iterable,
        options: {
          cwd: projectDir,
          mcpServers: { mekiri: tools },
          canUseTool,
        },
      });

      for await (const message of q) {
        if (message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
                sawToolResult = true;
              }
            }
          }
        }
      }

      expect(sawToolResult).toBe(true);

      const persisted = await loadConfig(projectDir);
      expect(persisted.priorities.token_efficiency).toBe("aggressive");

      const log = await readAuditLog(projectDir);
      expect(log).toHaveLength(1);
      expect(log[0].event).toBe("configure_mekiri");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run the new live test**

Run: `cd packages/mekiri-host && npx vitest run test/repl.smoke.test.ts -t "configure_mekiri tool wiring"`
Expected: PASS (this makes a real, billed API call)

- [ ] **Step 3: Run the full mekiri-host test suite**

Run: `cd packages/mekiri-host && npx vitest run`
Expected: PASS, all tests green (includes all live tests — this is the full, billed suite)

- [ ] **Step 4: Commit**

```bash
git add packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "test(mekiri-host): add live smoke test for configure_mekiri tool wiring"
```
