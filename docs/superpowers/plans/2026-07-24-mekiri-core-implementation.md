# Mekiri Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `mekiri-core`, the deterministic, offline-testable library that implements the `prune`/`sprout` primitive's logic — quote→boundary matching, fruit/config schemas, branch creation via the Agent SDK's `forkSession`, audit logging, and metrics formulas — with zero live API calls.

**Architecture:** A single TypeScript package (`packages/mekiri-core`) inside an npm-workspaces monorepo. Pure functions operate on plain arrays of transcript lines (`RawLine[]`); the only I/O is local filesystem (config/audit files under `.mekiri/`) and the Agent SDK's `forkSession`, which is itself a local file operation (no network call). This package has no dependency on a running `query()` loop, ACP, or ClaudeCode CLI process — that's `mekiri-host`, a separate follow-up plan.

**Tech Stack:** TypeScript, Node.js 24, npm workspaces, Vitest, Zod, `@anthropic-ai/claude-agent-sdk` (for `forkSession` only in this plan).

## Global Constraints

- `branch_type` values are exactly `"prune"` and `"sprout"` — never any other string (design spec §1/§3/§4; tz.md §1/§6).
- `note_type` values are exactly `"portal"` and `"death_reload"` — unchanged from tz.md §6.1/§6.1 (this vocabulary was deliberately NOT renamed; it's a separate roguelike-metaphor layer).
- Quote matching is exact substring match only — no fuzzy/heuristic fallback, no "take the last occurrence" (tz.md §3; design spec §3).
- Quote search only considers `assistant`-type lines with `isSidechain: false`, only `text`-type content blocks (not `thinking`), and only lines after the last compact boundary (design spec §3; tz.md §5).
- `PortalFruit.files_touched` is required whenever `keep_code: true` (tz.md §6.1; design spec §5).
- `DeathReloadFruit.ruled_out` is always required (tz.md §6.1; design spec §5).
- Config defaults: `sprout.depth_limit = 1`, `sprout.parallelism = { mode: "single" }`, `sprout.wait_mode = "sync"`, `priorities.token_efficiency = "balanced"` (design spec §6).
- Config lives at `<projectDir>/.mekiri/config.json`; audit log at `<projectDir>/.mekiri/audit.jsonl` (design spec §6/§7).
- The `injectionRole` extension point is reserved but not implemented in Phase 1 — don't add a runtime-configurable field for it in this plan (design spec §5, "Резервируемая... точка расширения").

---

### Task 1: Monorepo scaffold and package skeleton

**Files:**
- Create: `package.json` (repo root)
- Create: `tsconfig.base.json`
- Create: `packages/mekiri-core/package.json`
- Create: `packages/mekiri-core/tsconfig.json`
- Create: `packages/mekiri-core/vitest.config.ts`
- Create: `packages/mekiri-core/src/index.ts`
- Test: `packages/mekiri-core/test/sanity.test.ts`

**Interfaces:**
- Produces: `PACKAGE_NAME` constant exported from `packages/mekiri-core/src/index.ts`, used by no later task (pure toolchain smoke check).

- [ ] **Step 1: Create the root workspace `package.json`**

```json
{
  "name": "mekiri",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

- [ ] **Step 3: Create `packages/mekiri-core/package.json`**

```json
{
  "name": "mekiri-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "zod": "^3.23.8",
    "@anthropic-ai/claude-agent-sdk": "^0.3.218"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 4: Create `packages/mekiri-core/tsconfig.json`**

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

- [ ] **Step 5: Create `packages/mekiri-core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: Install dependencies from repo root**

Run: `npm install`
Expected: lockfile created, no errors. This installs `@anthropic-ai/claude-agent-sdk`, `zod`, `typescript`, `vitest` into the workspace.

- [ ] **Step 7: Write the failing sanity test**

Create `packages/mekiri-core/test/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package sanity", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-core");
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: FAIL — `src/index.ts` doesn't exist yet, or doesn't export `PACKAGE_NAME`.

- [ ] **Step 9: Create the minimal implementation**

Create `packages/mekiri-core/src/index.ts`:

```ts
export const PACKAGE_NAME = "mekiri-core";
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (1 test).

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.base.json packages/mekiri-core
git commit -m "chore: scaffold mekiri monorepo and mekiri-core package"
```

---

### Task 2: Core types and Fruit schemas

**Files:**
- Create: `packages/mekiri-core/src/types.ts`
- Create: `packages/mekiri-core/src/fruitSchema.ts`
- Test: `packages/mekiri-core/test/fruitSchema.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NoteType`, `BranchType`, `FileTouched`, `PortalFruit`, `DeathReloadFruit`, `Fruit`, `RawLine`, `BoundaryResult` types (from `types.ts`); `validateFruit(args: ValidateFruitArgs): ValidateFruitResult` (from `fruitSchema.ts`) — used by Task 9's integration test and by the future `mekiri-host` plan.

- [ ] **Step 1: Write `types.ts`**

Create `packages/mekiri-core/src/types.ts`:

```ts
export type NoteType = "portal" | "death_reload";
export type BranchType = "prune" | "sprout";

export interface FileTouched {
  path: string;
  change: string;
}

export interface PortalFruit {
  summary: string;
  files_touched?: FileTouched[];
  gotchas?: string;
}

export interface DeathReloadFruit {
  tried: string;
  ruled_out: string;
  facts_learned?: string;
  trigger?: "self_detected" | "user_feedback";
}

export type Fruit = PortalFruit | DeathReloadFruit;

/**
 * One line of a Claude Code session transcript, in the subset of fields
 * mekiri-core cares about. `[key: string]: unknown` preserves every other
 * field so a RawLine can round-trip through JSON.stringify without loss.
 */
export interface RawLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: unknown;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }> | string;
  };
  [key: string]: unknown;
}

export type BoundaryResult =
  | { status: "ok"; uuid: string }
  | { status: "not_found" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "in_compacted_zone"; lastCompactUuid: string };
```

- [ ] **Step 2: Write the failing test for `validateFruit`**

Create `packages/mekiri-core/test/fruitSchema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateFruit } from "../src/fruitSchema.js";

describe("validateFruit", () => {
  it("accepts a portal fruit without files_touched when keep_code is false", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause" },
      keepCode: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing files_touched when keep_code is true", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause" },
      keepCode: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/files_touched/);
    }
  });

  it("accepts a portal fruit with files_touched when keep_code is true", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {
        summary: "read logs, found the cause",
        files_touched: [{ path: "src/foo.ts", change: "fixed off-by-one" }],
      },
      keepCode: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing summary", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {},
      keepCode: false,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a death_reload fruit with tried and ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug", ruled_out: "it's not serialization" },
      keepCode: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a death_reload fruit missing ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug" },
      keepCode: true,
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run test/fruitSchema.test.ts`
Expected: FAIL — `src/fruitSchema.ts` doesn't exist yet.

- [ ] **Step 4: Write `fruitSchema.ts`**

Create `packages/mekiri-core/src/fruitSchema.ts`:

```ts
import { z } from "zod";
import type { NoteType, PortalFruit, DeathReloadFruit } from "./types.js";

const FileTouchedSchema = z.object({
  path: z.string(),
  change: z.string(),
});

const PortalFruitSchema = z.object({
  summary: z.string().min(1),
  files_touched: z.array(FileTouchedSchema).optional(),
  gotchas: z.string().optional(),
});

const DeathReloadFruitSchema = z.object({
  tried: z.string().min(1),
  ruled_out: z.string().min(1),
  facts_learned: z.string().optional(),
  trigger: z.enum(["self_detected", "user_feedback"]).optional(),
});

export interface ValidateFruitArgs {
  noteType: NoteType;
  fruit: unknown;
  keepCode: boolean;
}

export type ValidateFruitResult =
  | { ok: true; fruit: PortalFruit | DeathReloadFruit }
  | { ok: false; errors: string[] };

export function validateFruit(args: ValidateFruitArgs): ValidateFruitResult {
  if (args.noteType === "portal") {
    const parsed = PortalFruitSchema.safeParse(args.fruit);
    if (!parsed.success) {
      return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
    }
    if (args.keepCode && !parsed.data.files_touched) {
      return { ok: false, errors: ["files_touched is required when keep_code is true"] };
    }
    return { ok: true, fruit: parsed.data };
  }

  const parsed = DeathReloadFruitSchema.safeParse(args.fruit);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, fruit: parsed.data };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run test/fruitSchema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`:

```ts
export const PACKAGE_NAME = "mekiri-core";

export type {
  NoteType,
  BranchType,
  FileTouched,
  PortalFruit,
  DeathReloadFruit,
  Fruit,
  RawLine,
  BoundaryResult,
} from "./types.js";
export { validateFruit } from "./fruitSchema.js";
export type { ValidateFruitArgs, ValidateFruitResult } from "./fruitSchema.js";
```

- [ ] **Step 7: Run the full test suite to confirm nothing broke**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (7 tests total).

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-core/src/types.ts packages/mekiri-core/src/fruitSchema.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/fruitSchema.test.ts
git commit -m "feat(mekiri-core): add core types and fruit validation"
```

---

### Task 3: Transcript test helper and compact-zone detection

**Files:**
- Create: `packages/mekiri-core/test/helpers/buildTranscript.ts`
- Create: `packages/mekiri-core/src/compactZone.ts`
- Test: `packages/mekiri-core/test/compactZone.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `RawLine` (Task 2).
- Produces: `findLastCompactBoundaryIndex(lines: RawLine[]): number` (from `compactZone.ts`) — consumed by Task 4's quote matcher. Test helper `resetUuidCounter()`, `userLine(parentUuid, text)`, `assistantLine(parentUuid, text, opts?)`, `compactPair(parentUuid)` (from `test/helpers/buildTranscript.ts`) — consumed by Task 4 and Task 7's tests.

**Background:** real Claude Code transcripts mark a compaction as two consecutive lines: `{"type":"system","compactMetadata":{...}}` followed by `{"type":"user","isCompactSummary":true}` (verified directly against real `~/.claude/projects/*/*.jsonl` files during design). Everything at or before the `isCompactSummary` line is the "compacted zone" — read-only, not searchable for quote boundaries (tz.md §5).

- [ ] **Step 1: Write the transcript builder test helper**

Create `packages/mekiri-core/test/helpers/buildTranscript.ts`:

```ts
import type { RawLine } from "../../src/types.js";

let counter = 0;

export function resetUuidCounter(): void {
  counter = 0;
}

function nextUuid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function userLine(parentUuid: string | null, text: string): RawLine {
  return {
    type: "user",
    uuid: nextUuid("user"),
    parentUuid,
    isSidechain: false,
    message: { role: "user", content: text },
  };
}

export function assistantLine(
  parentUuid: string | null,
  text: string,
  opts: { isSidechain?: boolean } = {},
): RawLine {
  return {
    type: "assistant",
    uuid: nextUuid("asst"),
    parentUuid,
    isSidechain: opts.isSidechain ?? false,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** An assistant line whose only matching text lives in a `thinking` block, not `text`. */
export function assistantThinkingLine(parentUuid: string | null, thinkingText: string): RawLine {
  return {
    type: "assistant",
    uuid: nextUuid("asst"),
    parentUuid,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "thinking", text: thinkingText }] },
  };
}

export interface CompactPairResult {
  system: RawLine;
  summary: RawLine;
  lastUuid: string;
}

export function compactPair(parentUuid: string | null): CompactPairResult {
  const system: RawLine = {
    type: "system",
    compactMetadata: { trigger: "auto" },
  };
  const summaryUuid = nextUuid("compact-summary");
  const summary: RawLine = {
    type: "user",
    uuid: summaryUuid,
    parentUuid,
    isSidechain: false,
    isCompactSummary: true,
  };
  return { system, summary, lastUuid: summaryUuid };
}
```

- [ ] **Step 2: Write the failing test for compact-zone detection**

Create `packages/mekiri-core/test/compactZone.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { findLastCompactBoundaryIndex } from "../src/compactZone.js";
import { resetUuidCounter, userLine, assistantLine, compactPair } from "./helpers/buildTranscript.js";
import type { RawLine } from "../src/types.js";

describe("findLastCompactBoundaryIndex", () => {
  beforeEach(() => {
    resetUuidCounter();
  });

  it("returns -1 when there is no compact event", () => {
    const u1 = userLine(null, "hello");
    const a1 = assistantLine(u1.uuid!, "hi there");
    expect(findLastCompactBoundaryIndex([u1, a1])).toBe(-1);
  });

  it("returns the index of the compact summary line when there is one", () => {
    const u1 = userLine(null, "hello");
    const a1 = assistantLine(u1.uuid!, "working on it");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "continuing after compact");
    const lines: RawLine[] = [u1, a1, system, summary, a2];
    expect(findLastCompactBoundaryIndex(lines)).toBe(3);
  });

  it("returns the index of the LAST compact summary when there are two", () => {
    const u1 = userLine(null, "hello");
    const first = compactPair(u1.uuid!);
    const a1 = assistantLine(first.summary.uuid!, "between compacts");
    const second = compactPair(a1.uuid!);
    const a2 = assistantLine(second.summary.uuid!, "after second compact");
    const lines: RawLine[] = [u1, first.system, first.summary, a1, second.system, second.summary, a2];
    expect(findLastCompactBoundaryIndex(lines)).toBe(5);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run test/compactZone.test.ts`
Expected: FAIL — `src/compactZone.ts` doesn't exist yet.

- [ ] **Step 4: Write `compactZone.ts`**

Create `packages/mekiri-core/src/compactZone.ts`:

```ts
import type { RawLine } from "./types.js";

/**
 * Returns the index of the last `isCompactSummary` line in `lines`, or -1 if
 * the transcript has never been compacted. Everything at or before this
 * index is read-only (tz.md §5) — quote search must start after it.
 */
export function findLastCompactBoundaryIndex(lines: RawLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === "user" && lines[i].isCompactSummary === true) {
      return i;
    }
  }
  return -1;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run test/compactZone.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { findLastCompactBoundaryIndex } from "./compactZone.js";
```

- [ ] **Step 7: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (10 tests total).

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-core/test/helpers packages/mekiri-core/src/compactZone.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/compactZone.test.ts
git commit -m "feat(mekiri-core): add transcript test helper and compact-zone detection"
```

---

### Task 4: Quote→boundary matcher

**Files:**
- Create: `packages/mekiri-core/src/quoteMatcher.ts`
- Test: `packages/mekiri-core/test/quoteMatcher.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `RawLine`, `BoundaryResult` (Task 2); `findLastCompactBoundaryIndex` (Task 3); `userLine`/`assistantLine`/`assistantThinkingLine`/`compactPair`/`resetUuidCounter` (Task 3 test helper).
- Produces: `findBoundary(lines: RawLine[], quote: string): BoundaryResult` — consumed by Task 7's branch-creation test and by the future `mekiri-host` plan's `prune` tool handler.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-core/test/quoteMatcher.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { findBoundary } from "../src/quoteMatcher.js";
import {
  resetUuidCounter,
  userLine,
  assistantLine,
  assistantThinkingLine,
  compactPair,
} from "./helpers/buildTranscript.js";
import type { RawLine } from "../src/types.js";

describe("findBoundary", () => {
  beforeEach(() => {
    resetUuidCounter();
  });

  it("finds a unique quote and returns its message uuid", () => {
    const u1 = userLine(null, "fix the flaky test");
    const a1 = assistantLine(u1.uuid!, "Reading the 7000 lines of CI logs now to find the root cause.");
    const a2 = assistantLine(a1.uuid!, "Found it: a race condition in the retry loop.");
    const lines: RawLine[] = [u1, a1, a2];

    const result = findBoundary(lines, "Reading the 7000 lines of CI logs");
    expect(result).toEqual({ status: "ok", uuid: a1.uuid });
  });

  it("returns not_found when the quote appears nowhere", () => {
    const u1 = userLine(null, "fix the flaky test");
    const a1 = assistantLine(u1.uuid!, "Looking into it.");
    const result = findBoundary([u1, a1], "this text does not appear anywhere");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns ambiguous when the quote matches two different assistant messages", () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "Checking the database schema for issues.");
    const a2 = assistantLine(a1.uuid!, "Checking the database schema for issues, again more carefully.");
    const result = findBoundary([u1, a1, a2], "Checking the database schema for issues");
    expect(result).toEqual({ status: "ambiguous", occurrences: 2 });
  });

  it("ignores sidechain assistant messages", () => {
    const u1 = userLine(null, "investigate");
    const sidechain = assistantLine(u1.uuid!, "This unique sidechain phrase should not match.", {
      isSidechain: true,
    });
    const result = findBoundary([u1, sidechain], "This unique sidechain phrase");
    expect(result).toEqual({ status: "not_found" });
  });

  it("ignores thinking blocks, only matching visible text blocks", () => {
    const u1 = userLine(null, "investigate");
    const thinking = assistantThinkingLine(u1.uuid!, "Internal reasoning phrase that should not match.");
    const result = findBoundary([u1, thinking], "Internal reasoning phrase");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns in_compacted_zone when the quote only exists before the last compact boundary", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "This sentence lives before the compaction event.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "This is fresh work after the compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "This sentence lives before the compaction");
    expect(result).toEqual({ status: "in_compacted_zone", lastCompactUuid: summary.uuid });
  });

  it("only searches after the last compact boundary when one exists", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "Shared phrase appears here too, before compaction.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "Shared phrase appears here too, after compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "Shared phrase appears here too");
    expect(result).toEqual({ status: "ok", uuid: a2.uuid });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-core && npx vitest run test/quoteMatcher.test.ts`
Expected: FAIL — `src/quoteMatcher.ts` doesn't exist yet.

- [ ] **Step 3: Write `quoteMatcher.ts`**

Create `packages/mekiri-core/src/quoteMatcher.ts`:

```ts
import type { BoundaryResult, RawLine } from "./types.js";
import { findLastCompactBoundaryIndex } from "./compactZone.js";

function messageContainsQuote(line: RawLine, quote: string): boolean {
  if (line.type !== "assistant" || line.isSidechain) return false;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.includes(quote));
}

export function findBoundary(lines: RawLine[], quote: string): BoundaryResult {
  const boundaryIdx = findLastCompactBoundaryIndex(lines);
  const searchStart = boundaryIdx + 1;

  const matches: string[] = [];
  for (let i = searchStart; i < lines.length; i++) {
    const line = lines[i];
    if (messageContainsQuote(line, quote) && line.uuid) {
      matches.push(line.uuid);
    }
  }

  if (matches.length === 1) {
    return { status: "ok", uuid: matches[0] };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", occurrences: matches.length };
  }

  if (boundaryIdx >= 0) {
    for (let i = 0; i < searchStart; i++) {
      if (messageContainsQuote(lines[i], quote)) {
        return { status: "in_compacted_zone", lastCompactUuid: lines[boundaryIdx].uuid ?? "" };
      }
    }
  }

  return { status: "not_found" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-core && npx vitest run test/quoteMatcher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { findBoundary } from "./quoteMatcher.js";
```

- [ ] **Step 6: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (17 tests total).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-core/src/quoteMatcher.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/quoteMatcher.test.ts
git commit -m "feat(mekiri-core): add quote-to-boundary matcher"
```

---

### Task 5: Config schema and store

**Files:**
- Create: `packages/mekiri-core/src/configSchema.ts`
- Create: `packages/mekiri-core/src/configStore.ts`
- Test: `packages/mekiri-core/test/configSchema.test.ts`
- Test: `packages/mekiri-core/test/configStore.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone).
- Produces: `MekiriConfig` type, `defaultConfig(): MekiriConfig`, `MekiriConfigSchema` (Zod) (from `configSchema.ts`); `loadConfig(projectDir: string): Promise<MekiriConfig>`, `saveConfig(projectDir: string, config: MekiriConfig): Promise<void>`, `applyConfigPatch(current: MekiriConfig, patch: unknown): ConfigPatchResult` (from `configStore.ts`) — consumed by the future `mekiri-host` plan's `configure_mekiri` and `sprout` tool handlers.

- [ ] **Step 1: Write the failing test for the config schema**

Create `packages/mekiri-core/test/configSchema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MekiriConfigSchema, defaultConfig } from "../src/configSchema.js";

describe("MekiriConfigSchema", () => {
  it("produces the documented Phase 1 defaults from an empty object", () => {
    const config = defaultConfig();
    expect(config).toEqual({
      sprout: {
        depth_limit: 1,
        parallelism: { mode: "single" },
        wait_mode: "sync",
      },
      priorities: {
        token_efficiency: "balanced",
      },
    });
  });

  it("accepts a partial override merged onto defaults via parse", () => {
    const config = MekiriConfigSchema.parse({ sprout: { depth_limit: 3 } });
    expect(config.sprout.depth_limit).toBe(3);
    expect(config.sprout.wait_mode).toBe("sync");
  });

  it("rejects an invalid wait_mode", () => {
    const result = MekiriConfigSchema.safeParse({ sprout: { wait_mode: "eventually" } });
    expect(result.success).toBe(false);
  });

  it("accepts a parallel mode with a count", () => {
    const config = MekiriConfigSchema.parse({
      sprout: { parallelism: { mode: "parallel", count: 3 } },
    });
    expect(config.sprout.parallelism).toEqual({ mode: "parallel", count: 3 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run test/configSchema.test.ts`
Expected: FAIL — `src/configSchema.ts` doesn't exist yet.

- [ ] **Step 3: Write `configSchema.ts`**

Create `packages/mekiri-core/src/configSchema.ts`:

```ts
import { z } from "zod";

const ParallelismSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single") }),
  z.object({ mode: z.literal("parallel"), count: z.number().int().min(1) }),
]);

export const MekiriConfigSchema = z.object({
  sprout: z
    .object({
      depth_limit: z.number().int().min(0).default(1),
      parallelism: ParallelismSchema.default({ mode: "single" }),
      wait_mode: z.enum(["sync", "async"]).default("sync"),
    })
    .default({}),
  priorities: z
    .object({
      token_efficiency: z.enum(["aggressive", "balanced", "irrelevant"]).default("balanced"),
    })
    .default({}),
});

export type MekiriConfig = z.infer<typeof MekiriConfigSchema>;

export function defaultConfig(): MekiriConfig {
  return MekiriConfigSchema.parse({});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run test/configSchema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for the config store**

Create `packages/mekiri-core/test/configStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, applyConfigPatch } from "../src/configStore.js";
import { defaultConfig } from "../src/configSchema.js";

describe("config store", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-config-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig(projectDir);
    expect(config).toEqual(defaultConfig());
  });

  it("round-trips a saved config", async () => {
    const config = { ...defaultConfig(), sprout: { depth_limit: 2, parallelism: { mode: "single" as const }, wait_mode: "sync" as const } };
    await saveConfig(projectDir, config);
    const loaded = await loadConfig(projectDir);
    expect(loaded).toEqual(config);
  });

  it("applyConfigPatch deep-merges and validates", () => {
    const result = applyConfigPatch(defaultConfig(), { sprout: { depth_limit: 5 } });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config.sprout.depth_limit).toBe(5);
      expect(result.config.priorities.token_efficiency).toBe("balanced");
    }
  });

  it("applyConfigPatch rejects an invalid patch", () => {
    const result = applyConfigPatch(defaultConfig(), { priorities: { token_efficiency: "yolo" } });
    expect(result.status).toBe("invalid");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run test/configStore.test.ts`
Expected: FAIL — `src/configStore.ts` doesn't exist yet.

- [ ] **Step 7: Write `configStore.ts`**

Create `packages/mekiri-core/src/configStore.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { MekiriConfigSchema, defaultConfig, type MekiriConfig } from "./configSchema.js";

const CONFIG_RELATIVE_PATH = path.join(".mekiri", "config.json");

export async function loadConfig(projectDir: string): Promise<MekiriConfig> {
  const filePath = path.join(projectDir, CONFIG_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = MekiriConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(projectDir: string, config: MekiriConfig): Promise<void> {
  const filePath = path.join(projectDir, CONFIG_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export type ConfigPatchResult =
  | { status: "ok"; config: MekiriConfig }
  | { status: "invalid"; errors: string[] };

export function applyConfigPatch(current: MekiriConfig, patch: unknown): ConfigPatchResult {
  const merged = deepMerge(current as Record<string, unknown>, patch as Record<string, unknown>);
  const parsed = MekiriConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return { status: "invalid", errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { status: "ok", config: parsed.data };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  const baseIsObject = typeof base === "object" && base !== null && !Array.isArray(base);
  const patchIsObject = typeof patch === "object" && patch !== null && !Array.isArray(patch);

  if (baseIsObject && patchIsObject) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      result[key] = deepMerge((base as Record<string, unknown>)[key], value);
    }
    return result;
  }
  return patch === undefined ? base : patch;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run test/configStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { MekiriConfigSchema, defaultConfig } from "./configSchema.js";
export type { MekiriConfig } from "./configSchema.js";
export { loadConfig, saveConfig, applyConfigPatch } from "./configStore.js";
export type { ConfigPatchResult } from "./configStore.js";
```

- [ ] **Step 10: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (25 tests total).

- [ ] **Step 11: Commit**

```bash
git add packages/mekiri-core/src/configSchema.ts packages/mekiri-core/src/configStore.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/configSchema.test.ts packages/mekiri-core/test/configStore.test.ts
git commit -m "feat(mekiri-core): add config schema and file-backed store"
```

---

### Task 6: Audit log

**Files:**
- Create: `packages/mekiri-core/src/auditLog.ts`
- Test: `packages/mekiri-core/test/auditLog.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `NoteType`, `BranchType` (Task 2).
- Produces: `PruneAuditEntry`, `SproutAuditEntry`, `ConfigureAuditEntry`, `AuditEntry` types; `appendAuditEntry(projectDir: string, entry: AuditEntry): Promise<void>`, `readAuditLog(projectDir: string): Promise<AuditEntry[]>` — consumed by Task 7 (branch creation) and Task 8 (metrics).

- [ ] **Step 1: Write the failing test**

Create `packages/mekiri-core/test/auditLog.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAuditEntry, readAuditLog, type AuditEntry } from "../src/auditLog.js";

describe("audit log", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-audit-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns an empty array when no log file exists", async () => {
    expect(await readAuditLog(projectDir)).toEqual([]);
  });

  it("appends and reads back entries in order", async () => {
    const first: AuditEntry = {
      event: "prune",
      timestamp: "2026-07-24T00:00:00.000Z",
      sessionId: "parent-1",
      newSessionId: "child-1",
      noteType: "portal",
      removedBranchLength: 4,
      fruitLength: 42,
    };
    const second: AuditEntry = {
      event: "sprout",
      timestamp: "2026-07-24T00:01:00.000Z",
      sessionId: "parent-1",
      childSessionId: "child-2",
      branchLength: 10,
      harvestLength: 20,
    };
    await appendAuditEntry(projectDir, first);
    await appendAuditEntry(projectDir, second);

    const log = await readAuditLog(projectDir);
    expect(log).toEqual([first, second]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mekiri-core && npx vitest run test/auditLog.test.ts`
Expected: FAIL — `src/auditLog.ts` doesn't exist yet.

- [ ] **Step 3: Write `auditLog.ts`**

Create `packages/mekiri-core/src/auditLog.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteType } from "./types.js";

export interface PruneAuditEntry {
  event: "prune";
  timestamp: string;
  sessionId: string;
  newSessionId: string;
  noteType: NoteType;
  /** Number of transcript lines removed by this prune. */
  removedBranchLength: number;
  /** Length in characters of the serialized fruit — a Phase 1 proxy metric.
   *  Real token counts require live SDK usage data (see mekiri-host plan). */
  fruitLength: number;
}

export interface SproutAuditEntry {
  event: "sprout";
  timestamp: string;
  sessionId: string;
  childSessionId: string;
  /** Number of transcript lines produced by the sprouted branch. */
  branchLength: number;
  /** Length in characters of the serialized harvest result — Phase 1 proxy metric. */
  harvestLength: number;
}

export interface ConfigureAuditEntry {
  event: "configure_mekiri";
  timestamp: string;
  reason: string;
  patch: unknown;
}

export type AuditEntry = PruneAuditEntry | SproutAuditEntry | ConfigureAuditEntry;

const AUDIT_RELATIVE_PATH = path.join(".mekiri", "audit.jsonl");

export async function appendAuditEntry(projectDir: string, entry: AuditEntry): Promise<void> {
  const filePath = path.join(projectDir, AUDIT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readAuditLog(projectDir: string): Promise<AuditEntry[]> {
  const filePath = path.join(projectDir, AUDIT_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mekiri-core && npx vitest run test/auditLog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { appendAuditEntry, readAuditLog } from "./auditLog.js";
export type { AuditEntry, PruneAuditEntry, SproutAuditEntry, ConfigureAuditEntry } from "./auditLog.js";
```

- [ ] **Step 6: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (27 tests total).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-core/src/auditLog.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/auditLog.test.ts
git commit -m "feat(mekiri-core): add append-only audit log"
```

---

### Task 7: Branch creation via the Agent SDK's `forkSession`

**Files:**
- Create: `packages/mekiri-core/src/branch.ts`
- Create: `packages/mekiri-core/test/helpers/sessionFile.ts`
- Test: `packages/mekiri-core/test/branch.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `BranchType`, `NoteType` (Task 2); `appendAuditEntry` (Task 6); `resetUuidCounter`/`userLine`/`assistantLine` (Task 3 test helper); `forkSession` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `createBranch(args: CreateBranchArgs): Promise<CreateBranchResult>` — consumed by Task 9's integration test and by the future `mekiri-host` plan's `prune`/`sprout` tool handlers.

**Background:** `@anthropic-ai/claude-agent-sdk` ships `forkSession(sessionId, { dir?, upToMessageId?, title? })`, which copies transcript messages into a new session file (remapping UUIDs, preserving the `parentUuid` chain) under the standard `<CLAUDE_CONFIG_DIR>/projects/<sanitized-dir>/<sessionId>.jsonl` layout, and supports slicing via `upToMessageId`. This is a local file operation — no network call, no API cost.

The SDK also exposes a `sessionStore`/`InMemorySessionStore` path for fully in-memory testing, but its exact `projectKey` resolution when a custom store is combined with (or without) `dir` is not documented in the shipped `.d.ts` and wasn't practical to verify empirically in this environment (a fresh `npm install` of the SDK repeatedly timed out over the sandbox's network link). Rather than encode a guess about undocumented internal behavior, this task uses the plain-filesystem path instead, which rests on two independently verifiable facts gathered directly from this machine's real `~/.claude/projects/` during design: (1) `CLAUDE_CONFIG_DIR` overrides the base config directory (documented in `sdk.d.ts`), and (2) Claude Code's project-directory sanitization is "replace every `/` in the absolute cwd path with `-`" — confirmed by inspecting multiple real entries under `~/.claude/projects/` (e.g. `/home/pol/dev/rollback` → `-home-pol-dev-rollback`).

- [ ] **Step 1: Write the session-file test helper**

Create `packages/mekiri-core/test/helpers/sessionFile.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RawLine } from "../../src/types.js";

/**
 * Mirrors Claude Code's project-directory sanitization: replace path
 * separators with dashes. Verified against real entries under
 * ~/.claude/projects/ during design (e.g. /home/pol/dev/rollback ->
 * -home-pol-dev-rollback). If a future SDK version changes this rule,
 * the tests in this file will fail loudly with ENOENT, not silently.
 */
export function sanitizeDir(dir: string): string {
  return dir.replace(/\//g, "-");
}

export function sessionFilePath(configDir: string, dir: string, sessionId: string): string {
  return path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
}

export async function writeSessionFile(
  configDir: string,
  dir: string,
  sessionId: string,
  lines: RawLine[],
): Promise<void> {
  const filePath = sessionFilePath(configDir, dir, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(filePath, content, "utf8");
}

export async function readSessionFile(configDir: string, dir: string, sessionId: string): Promise<RawLine[]> {
  const filePath = sessionFilePath(configDir, dir, sessionId);
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawLine);
}

export async function sessionFileExists(configDir: string, dir: string, sessionId: string): Promise<boolean> {
  try {
    await fs.access(sessionFilePath(configDir, dir, sessionId));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/mekiri-core/test/branch.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBranch } from "../src/branch.js";
import { readAuditLog } from "../src/auditLog.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile, sessionFileExists } from "./helpers/sessionFile.js";

describe("createBranch", () => {
  let configDir: string;
  let projectDir: string;
  let auditDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    resetUuidCounter();
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-claude-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-project-"));
    auditDir = await mkdtemp(path.join(tmpdir(), "mekiri-branch-audit-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(auditDir, { recursive: true, force: true });
  });

  it("prunes a branch: forks up to the boundary, drops later messages, records an audit entry", async () => {
    const u1 = userLine(null, "please fix the bug");
    const a1 = assistantLine(u1.uuid!, "reading logs now, this is the boundary sentence");
    const a2 = assistantLine(a1.uuid!, "more garbage that must not survive the prune");
    await writeSessionFile(configDir, projectDir, "parent-session", [u1, a1, a2]);

    const { newSessionId } = await createBranch({
      branchType: "prune",
      sessionId: "parent-session",
      dir: projectDir,
      upToMessageId: a1.uuid!,
      noteType: "portal",
      removedBranchLength: 1,
      fruitLength: 42,
      auditProjectDir: auditDir,
    });

    expect(newSessionId).not.toBe("parent-session");
    expect(await sessionFileExists(configDir, projectDir, newSessionId)).toBe(true);

    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    expect(forkedLines.map((line) => line.type)).toEqual(["user", "assistant"]);

    const originalLines = await readSessionFile(configDir, projectDir, "parent-session");
    expect(originalLines).toHaveLength(3);

    const log = await readAuditLog(auditDir);
    expect(log).toEqual([
      {
        event: "prune",
        timestamp: log[0].timestamp,
        sessionId: "parent-session",
        newSessionId,
        noteType: "portal",
        removedBranchLength: 1,
        fruitLength: 42,
      },
    ]);
  });

  it("sprouts a branch: full copy, parent untouched, records a sprout audit entry", async () => {
    const u1 = userLine(null, "keep working on the feature");
    const a1 = assistantLine(u1.uuid!, "understood, continuing");
    await writeSessionFile(configDir, projectDir, "parent-session-2", [u1, a1]);

    const { newSessionId } = await createBranch({
      branchType: "sprout",
      sessionId: "parent-session-2",
      dir: projectDir,
      removedBranchLength: 5,
      fruitLength: 30,
      auditProjectDir: auditDir,
    });

    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    expect(forkedLines).toHaveLength(2);

    const originalLines = await readSessionFile(configDir, projectDir, "parent-session-2");
    expect(originalLines).toHaveLength(2);

    const log = await readAuditLog(auditDir);
    expect(log).toEqual([
      {
        event: "sprout",
        timestamp: log[0].timestamp,
        sessionId: "parent-session-2",
        childSessionId: newSessionId,
        branchLength: 5,
        harvestLength: 30,
      },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/mekiri-core && npx vitest run test/branch.test.ts`
Expected: FAIL — `src/branch.ts` doesn't exist yet.

- [ ] **Step 4: Write `branch.ts`**

Create `packages/mekiri-core/src/branch.ts`:

```ts
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { NoteType } from "./types.js";
import { appendAuditEntry } from "./auditLog.js";

interface CreateBranchCommon {
  sessionId: string;
  dir: string;
  removedBranchLength: number;
  fruitLength: number;
  auditProjectDir: string;
}

export type CreateBranchArgs =
  | (CreateBranchCommon & { branchType: "prune"; upToMessageId: string; noteType: NoteType })
  | (CreateBranchCommon & { branchType: "sprout" });

export interface CreateBranchResult {
  newSessionId: string;
}

export async function createBranch(args: CreateBranchArgs): Promise<CreateBranchResult> {
  const result = await forkSession(args.sessionId, {
    dir: args.dir,
    upToMessageId: args.branchType === "prune" ? args.upToMessageId : undefined,
  });

  if (args.branchType === "prune") {
    await appendAuditEntry(args.auditProjectDir, {
      event: "prune",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      newSessionId: result.sessionId,
      noteType: args.noteType,
      removedBranchLength: args.removedBranchLength,
      fruitLength: args.fruitLength,
    });
  } else {
    await appendAuditEntry(args.auditProjectDir, {
      event: "sprout",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      childSessionId: result.sessionId,
      branchLength: args.removedBranchLength,
      harvestLength: args.fruitLength,
    });
  }

  return { newSessionId: result.sessionId };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/mekiri-core && npx vitest run test/branch.test.ts`
Expected: PASS (2 tests). If either test fails with an ENOENT/"session not found" style error, the sanitization rule in `test/helpers/sessionFile.ts`'s `sanitizeDir` no longer matches the installed SDK version — inspect a real file under `~/.claude/projects/` on the machine running the test, compare its directory name to its known absolute cwd, update `sanitizeDir` to match, and re-run. Do not loosen the test assertions instead.

- [ ] **Step 6: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { createBranch } from "./branch.js";
export type { CreateBranchArgs, CreateBranchResult } from "./branch.js";
```

- [ ] **Step 7: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (29 tests total).

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-core/src/branch.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/branch.test.ts packages/mekiri-core/test/helpers/sessionFile.ts
git commit -m "feat(mekiri-core): wrap Agent SDK forkSession as createBranch with audit logging"
```

---

### Task 8: Metrics formulas

**Files:**
- Create: `packages/mekiri-core/src/metrics.ts`
- Test: `packages/mekiri-core/test/metrics.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `AuditEntry`, `PruneAuditEntry`, `SproutAuditEntry` (Task 6).
- Produces: `distillationRatio(entry: PruneAuditEntry): number`, `branchCompression(entry: SproutAuditEntry): number`, `lifetimeTokenSavings(entry: PruneAuditEntry, subsequentRequestCount: number): number`, `contextRecyclingRatio(entries: AuditEntry[], totalContextProduced: number): number` — consumed by Task 9's integration test.

**Background:** tz.md §12.2 defines these formulas in terms of "length" without pinning a unit; per this plan's Global Constraints, "length" here is the character-length proxy recorded in the audit log (Task 6), not a live token count — that refinement belongs to the `mekiri-host` plan, which has access to real SDK usage data.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-core/test/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  distillationRatio,
  branchCompression,
  lifetimeTokenSavings,
  contextRecyclingRatio,
} from "../src/metrics.js";
import type { PruneAuditEntry, SproutAuditEntry, AuditEntry } from "../src/auditLog.js";

const pruneEntry: PruneAuditEntry = {
  event: "prune",
  timestamp: "2026-07-24T00:00:00.000Z",
  sessionId: "p1",
  newSessionId: "c1",
  noteType: "portal",
  removedBranchLength: 12400,
  fruitLength: 510,
};

const sproutEntry: SproutAuditEntry = {
  event: "sprout",
  timestamp: "2026-07-24T00:00:00.000Z",
  sessionId: "p1",
  childSessionId: "c2",
  branchLength: 2000,
  harvestLength: 400,
};

describe("metrics", () => {
  it("computes Distillation Ratio as removed length / fruit length", () => {
    expect(distillationRatio(pruneEntry)).toBeCloseTo(12400 / 510, 5);
  });

  it("computes Branch Compression as branch length / harvest length", () => {
    expect(branchCompression(sproutEntry)).toBeCloseTo(2000 / 400, 5);
  });

  it("computes Lifetime Token Savings as removed length times subsequent request count", () => {
    expect(lifetimeTokenSavings(pruneEntry, 5)).toBe(12400 * 5);
  });

  it("computes Context Recycling Ratio as sum of removed/branch lengths over total context", () => {
    const entries: AuditEntry[] = [pruneEntry, sproutEntry];
    const ratio = contextRecyclingRatio(entries, 20000);
    expect(ratio).toBeCloseTo((12400 + 2000) / 20000, 5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mekiri-core && npx vitest run test/metrics.test.ts`
Expected: FAIL — `src/metrics.ts` doesn't exist yet.

- [ ] **Step 3: Write `metrics.ts`**

Create `packages/mekiri-core/src/metrics.ts`:

```ts
import type { AuditEntry, PruneAuditEntry, SproutAuditEntry } from "./auditLog.js";

/** tz.md §12.2 — Distillation Ratio = removed branch length / fruit length. */
export function distillationRatio(entry: PruneAuditEntry): number {
  return entry.removedBranchLength / entry.fruitLength;
}

/** tz.md §12.2 — Branch Compression = branch length / harvest length. */
export function branchCompression(entry: SproutAuditEntry): number {
  return entry.branchLength / entry.harvestLength;
}

/** tz.md §12.2 — Lifetime Token Savings = removed length * subsequent request count. */
export function lifetimeTokenSavings(entry: PruneAuditEntry, subsequentRequestCount: number): number {
  return entry.removedBranchLength * subsequentRequestCount;
}

function branchLengthOf(entry: AuditEntry): number {
  if (entry.event === "prune") return entry.removedBranchLength;
  if (entry.event === "sprout") return entry.branchLength;
  return 0;
}

/** tz.md §12.2 — Context Recycling Ratio = sum of removed/branch lengths / total context produced. */
export function contextRecyclingRatio(entries: AuditEntry[], totalContextProduced: number): number {
  const recycled = entries.reduce((sum, entry) => sum + branchLengthOf(entry), 0);
  return recycled / totalContextProduced;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mekiri-core && npx vitest run test/metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Re-export from the package barrel**

Modify `packages/mekiri-core/src/index.ts`, add:

```ts
export { distillationRatio, branchCompression, lifetimeTokenSavings, contextRecyclingRatio } from "./metrics.js";
```

- [ ] **Step 6: Run the full suite**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (33 tests total).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-core/src/metrics.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/metrics.test.ts
git commit -m "feat(mekiri-core): add tz.md §12.2 metrics formulas"
```

---

### Task 9: Public API barrel review and composed integration test

**Files:**
- Modify: `packages/mekiri-core/src/index.ts` (final review pass)
- Test: `packages/mekiri-core/test/integration.test.ts`

**Interfaces:**
- Consumes: every symbol exported by `packages/mekiri-core/src/index.ts` from Tasks 1–8.
- Produces: nothing new — this task proves the whole package composes correctly end-to-end at the library level (no live API, no ACP, no host loop — that's the follow-up `mekiri-host` plan).

**Important — two facts about the real `forkSession` discovered empirically during Task 7, confirmed against the compiled `@anthropic-ai/claude-agent-sdk` source (not present in the SDK's `.d.ts` and not anticipated when this task was first drafted):**
1. `forkSession` validates `sessionId` and `upToMessageId` against a strict UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) and throws `Invalid sessionId: ...` / `Invalid upToMessageId: ...` otherwise — human-readable placeholder ids like `"integration-parent"` are rejected. `test/helpers/buildTranscript.ts`'s generated ids (`"user-1"`, `"asst-1"`, etc.) are not UUID-shaped either.
2. Every forked transcript gets one extra trailing `{"type":"custom-title", ...}` line appended beyond the copied/sliced message lines — not documented in the `.d.ts`.

Task 7's `test/branch.test.ts` established the pattern for handling both, confined entirely to test code (never touching `src/branch.ts` or the shared `test/helpers/buildTranscript.ts`): build transcript lines with the normal `userLine`/`assistantLine` helpers (to get a correct parent/child chain), then overwrite each line's `uuid`/`parentUuid` fields in place with literal UUID-shaped strings before writing the session file; and filter out `type === "custom-title"` lines before asserting on forked content, while separately asserting that exactly one such line is present (so the test still fails loudly if that assumption ever changes). Follow the same pattern here.

- [ ] **Step 1: Write the composed integration test**

Create `packages/mekiri-core/test/integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findBoundary } from "../src/quoteMatcher.js";
import { validateFruit } from "../src/fruitSchema.js";
import { createBranch } from "../src/branch.js";
import { readAuditLog } from "../src/auditLog.js";
import { distillationRatio } from "../src/metrics.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile } from "./helpers/sessionFile.js";

// forkSession requires real UUID-format sessionId/upToMessageId (verified
// during Task 7 against the SDK's compiled source) — buildTranscript.ts's
// generated ids aren't UUID-shaped, so overwrite them with literals here,
// the same way Task 7's branch.test.ts does.
const PARENT_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const U1_UUID = "33333333-3333-4333-8333-333333333333";
const A1_UUID = "44444444-4444-4444-8444-444444444444";
const A2_UUID = "55555555-5555-4555-8555-555555555555";

describe("mekiri-core end-to-end: read dirty logs, then prune(portal)", () => {
  let configDir: string;
  let projectDir: string;
  let auditDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    resetUuidCounter();
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-claude-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-integration-project-"));
    auditDir = await mkdtemp(path.join(tmpdir(), "mekiri-integration-audit-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(auditDir, { recursive: true, force: true });
  });

  it("finds the boundary, validates the fruit, prunes, and reports a Distillation Ratio", async () => {
    const u1 = userLine(null, "why is CI flaky?");
    const a1 = assistantLine(u1.uuid!, "Reading the 7000 lines of CI logs to find the root cause of the flake.");
    const a2 = assistantLine(a1.uuid!, "line 6234: retry loop races with the cleanup handler.");
    u1.uuid = U1_UUID;
    a1.uuid = A1_UUID;
    a1.parentUuid = U1_UUID;
    a2.uuid = A2_UUID;
    a2.parentUuid = A1_UUID;
    const lines = [u1, a1, a2];
    await writeSessionFile(configDir, projectDir, PARENT_SESSION_ID, lines);

    const boundary = findBoundary(lines, "Reading the 7000 lines of CI logs");
    expect(boundary.status).toBe("ok");
    if (boundary.status !== "ok") return;

    const fruitCheck = validateFruit({
      noteType: "portal",
      fruit: {
        summary: "CI flake is a retry/cleanup race; fixed by locking the cleanup handler.",
        files_touched: [{ path: "ci/retry.ts", change: "added lock around cleanup" }],
      },
      keepCode: true,
    });
    expect(fruitCheck.ok).toBe(true);
    if (!fruitCheck.ok) return;

    const fruitLength = JSON.stringify(fruitCheck.fruit).length;
    const removedBranchLength = lines.length - 2; // only a2 is discarded

    const { newSessionId } = await createBranch({
      branchType: "prune",
      sessionId: PARENT_SESSION_ID,
      dir: projectDir,
      upToMessageId: boundary.uuid,
      noteType: "portal",
      removedBranchLength,
      fruitLength,
      auditProjectDir: auditDir,
    });

    const forkedAllLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedAllLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines).toHaveLength(2); // u1, a1 only — a2's garbage did not survive
    expect(forkedAllLines.filter((line) => line.type === "custom-title")).toHaveLength(1);

    const log = await readAuditLog(auditDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("prune");
    if (log[0].event === "prune") {
      expect(distillationRatio(log[0])).toBeCloseTo(removedBranchLength / fruitLength, 5);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/mekiri-core && npx vitest run test/integration.test.ts`
Expected: PASS (1 test) — everything from Tasks 1–8 was already implemented, so this should pass without further code changes. If it fails, the failure is in how two already-implemented pieces compose, not in a missing implementation — investigate before editing tests to match broken behavior.

- [ ] **Step 3: Review `src/index.ts` for completeness**

Read `packages/mekiri-core/src/index.ts` and confirm it re-exports every symbol used across `test/*.test.ts` files (grep the test directory for `from "../src/` imports and cross-check against the barrel). Add any missing re-exports.

- [ ] **Step 4: Run the full suite one final time**

Run: `cd packages/mekiri-core && npx vitest run`
Expected: PASS (34 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/index.ts packages/mekiri-core/test/integration.test.ts
git commit -m "test(mekiri-core): add end-to-end integration test across the full package"
```

---

## Definition of Done

- `npm install && npx vitest run --root packages/mekiri-core` (or `cd packages/mekiri-core && npx vitest run`) passes with 0 failures.
- No task left a placeholder, a skipped test, or a TODO comment.
- `mekiri-core`'s public API (`src/index.ts`) exports everything the future `mekiri-host` plan will need: `validateFruit`, `findBoundary`, `findLastCompactBoundaryIndex`, `createBranch`, `loadConfig`/`saveConfig`/`applyConfigPatch`, `appendAuditEntry`/`readAuditLog`, and all metrics functions.
- Nothing in this package makes a network call or spends API tokens — verify by grepping `packages/mekiri-core/src` for `query(` (should be zero matches; that's `mekiri-host`'s job).
