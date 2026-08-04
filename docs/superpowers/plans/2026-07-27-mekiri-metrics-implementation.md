# Mekiri Metrics Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute all five tz.md §12.2 metrics (Distillation Ratio, Branch Compression, Lifetime Token Savings, Virtual Context Lifetime, Context Recycling Ratio) on real project data — real `.mekiri/audit.jsonl` plus real session transcript files — and print a report, closing the gap `core-primitive-design.md` §7 flagged as "a separate command, not yet built."

**Architecture:** Computation lives in `mekiri-core` (pure/testable without live SDK calls): a new `sessionTranscript.ts` (reads real session `.jsonl` files into `RawLine[]`), a new `sessionTree.ts` (reconstructs the prune/sprout tree from `audit.jsonl`), a new `virtualContextLifetime` formula added to the existing `metrics.ts`, and a new `metricsReport.ts` that ties the tree + transcripts + formulas into a full per-tree and project-wide report. `mekiri-host` gets a thin CLI entry point (`metricsCli.ts`) that calls into `mekiri-core` and formats the output — no computation logic in `mekiri-host` itself, matching the existing package split.

**Tech Stack:** TypeScript/Node (ESM, `NodeNext`), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-mekiri-metrics-design.md`.
- Distillation Ratio, Branch Compression: computed directly from `audit.jsonl` entries via the existing `distillationRatio`/`branchCompression` — no transcript reads needed for these two.
- Virtual Context Lifetime uses **only `prune` branches**, never `sprout` — a clone's content never occupied the parent's context, so it must not be added back into the virtual reconstruction (see spec §4 for the whitepaper §4.2 reasoning).
- The VCL "trunk" is the path of `prune` edges only, from a tree's root to the leaf with no further `prune` child. A session can have at most one `prune` child (a pruned session is archived and never pruned again), so this path is always well-defined and unique.
- VCL algorithm (exact, already worked out — do not re-derive): read the trunk tip's own transcript; `actualTurn` = `findLastCompactBoundaryIndex(tipTranscript)`; `threshold` = `JSON.stringify(tipTranscript.slice(0, actualTurn + 1)).length`; `priorGarbage` = sum of `removedOrBranchLength` over every trunk node **except the last** (the tip itself); walk the tip's transcript again from index 0 with cumulative length starting at `priorGarbage` (not 0), and `virtualTurn` is the first index where this cumulative length reaches `threshold`. If the trunk tip never compacted (`findLastCompactBoundaryIndex` returns `-1`), VCL for that tree is `undefined` ("not enough data"), never `0` and never an error.
- `virtualContextLifetime(actualTurn, virtualTurn) = (actualTurn - virtualTurn) / virtualTurn`.
- `sanitizeDir` (Claude Code's project-directory sanitization: every non-alphanumeric character → `-`) becomes canonical in `mekiri-core`; `mekiri-host`'s existing test helper (`packages/mekiri-host/test/helpers/sessionFile.ts`) must import it from there instead of keeping its own copy (DRY fix, not a separate task).
- Missing session files degrade gracefully to `[]` (same convention as `readAuditLog`), never throw.
- No new package. Computation in `mekiri-core`, CLI in `mekiri-host`, matching the existing split.

---

### Task 1: `sessionTranscript.ts` — read real session transcripts

**Files:**
- Create: `packages/mekiri-core/src/sessionTranscript.ts`
- Test: `packages/mekiri-core/test/sessionTranscript.test.ts`
- Modify: `packages/mekiri-core/src/index.ts` (add exports)
- Modify: `packages/mekiri-host/test/helpers/sessionFile.ts` (import `sanitizeDir` from `mekiri-core` instead of the local copy)

**Interfaces:**
- Produces: `sanitizeDir(dir: string): string` and `readSessionTranscript(dir: string, sessionId: string): Promise<RawLine[]>`, both exported from `mekiri-core`. Every later task that needs a real transcript imports `readSessionTranscript` from `mekiri-core`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-core/test/sessionTranscript.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeDir, readSessionTranscript } from "../src/sessionTranscript.js";
import type { RawLine } from "../src/types.js";

describe("sanitizeDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(sanitizeDir("/home/pol/dev/rollback")).toBe("-home-pol-dev-rollback");
  });
});

describe("readSessionTranscript", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;
  const projectDir = "/fake/project/dir";
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-transcript-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  it("returns [] when the session file doesn't exist", async () => {
    const lines = await readSessionTranscript(projectDir, sessionId);
    expect(lines).toEqual([]);
  });

  it("reads and parses a real session file", async () => {
    const lines: RawLine[] = [
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    const dirPath = path.join(configDir, "projects", sanitizeDir(projectDir));
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const result = await readSessionTranscript(projectDir, sessionId);
    expect(result).toEqual(lines);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=mekiri-core -- sessionTranscript`
Expected: FAIL — `../src/sessionTranscript.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/mekiri-core/src/sessionTranscript.ts`:

```ts
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RawLine } from "./types.js";

// Mirrors Claude Code's project-directory sanitization: replace every
// non-alphanumeric character with "-". Verified against the compiled SDK
// (originally established in mekiri-host's test fixtures); canonicalized
// here so production code and test fixtures share exactly one
// implementation instead of two copies drifting apart.
export function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

/**
 * Reads a real, already-recorded session transcript from disk --
 * $CLAUDE_CONFIG_DIR/projects/<sanitizeDir(dir)>/<sessionId>.jsonl, falling
 * back to ~/.claude when CLAUDE_CONFIG_DIR is unset. Returns [] (not a
 * throw) when the file doesn't exist, mirroring readAuditLog's convention.
 */
export async function readSessionTranscript(dir: string, sessionId: string): Promise<RawLine[]> {
  const filePath = path.join(resolveConfigDir(), "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RawLine);
  } catch {
    return [];
  }
}
```

Add to `packages/mekiri-core/src/index.ts`:

```ts
export { sanitizeDir, readSessionTranscript } from "./sessionTranscript.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- sessionTranscript`
Expected: PASS (3 tests).

- [ ] **Step 5: DRY fix — `mekiri-host`'s test helper**

Read `packages/mekiri-host/test/helpers/sessionFile.ts` first. It currently defines its own `sanitizeDir` function (with a comment explaining it was verified against the compiled SDK) and uses it inside `writeSessionFile`. Replace the local `sanitizeDir` function definition with an import from `mekiri-core`:

```ts
import { sanitizeDir } from "mekiri-core";
```

Remove the local `export function sanitizeDir(dir: string): string { ... }` definition and its explanatory comment (the comment now lives in `mekiri-core/src/sessionTranscript.ts` instead, where the canonical implementation is). Keep `writeSessionFile`'s own body unchanged — it already calls `sanitizeDir(dir)`, which now resolves to the imported one instead of a local one, with identical behavior.

Run: `npm run test --workspace=mekiri-host -- repl.smoke` (a quick check that fixture-writing tests using this helper still work — this doesn't need the full suite, just confirmation the import change didn't break anything)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-core/src/sessionTranscript.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/sessionTranscript.test.ts packages/mekiri-host/test/helpers/sessionFile.ts
git commit -m "feat(mekiri-core): add sessionTranscript.ts to read real session files"
```

---

### Task 2: `sessionTree.ts` — reconstruct the prune/sprout tree

**Files:**
- Create: `packages/mekiri-core/src/sessionTree.ts`
- Test: `packages/mekiri-core/test/sessionTree.test.ts`
- Modify: `packages/mekiri-core/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `AuditEntry`, `PruneAuditEntry`, `SproutAuditEntry` types (already exported from `mekiri-core`'s `auditLog.ts`).
- Produces: `SessionNode`, `SessionTree` types, `buildSessionForest(entries: AuditEntry[]): SessionTree[]`, `findPruneTrunk(tree: SessionTree): SessionNode[]` — all exported from `mekiri-core`. Task 4/5/6 import and use these directly.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-core/test/sessionTree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSessionForest, findPruneTrunk } from "../src/sessionTree.js";
import type { AuditEntry, PruneAuditEntry, SproutAuditEntry } from "../src/auditLog.js";

function pruneEntry(sessionId: string, newSessionId: string, timestamp: string): PruneAuditEntry {
  return { event: "prune", timestamp, sessionId, newSessionId, noteType: "portal", removedBranchLength: 100, fruitLength: 20 };
}

function sproutEntry(sessionId: string, childSessionId: string, timestamp: string): SproutAuditEntry {
  return { event: "sprout", timestamp, sessionId, childSessionId, branchLength: 50, harvestLength: 10 };
}

describe("buildSessionForest", () => {
  it("returns [] for an empty log", () => {
    expect(buildSessionForest([])).toEqual([]);
  });

  it("builds a single tree from a linear prune chain", () => {
    const entries: AuditEntry[] = [
      pruneEntry("root", "a", "2026-01-01T00:00:00.000Z"),
      pruneEntry("a", "b", "2026-01-01T01:00:00.000Z"),
    ];
    const forest = buildSessionForest(entries);
    expect(forest).toHaveLength(1);
    expect(forest[0].rootSessionId).toBe("root");
    expect(forest[0].nodes).toHaveLength(2);
    expect(forest[0].nodes.map((n) => n.sessionId).sort()).toEqual(["a", "b"]);
  });

  it("groups unrelated trees separately", () => {
    const entries: AuditEntry[] = [
      pruneEntry("root1", "a", "2026-01-01T00:00:00.000Z"),
      pruneEntry("root2", "b", "2026-01-02T00:00:00.000Z"),
    ];
    const forest = buildSessionForest(entries);
    expect(forest).toHaveLength(2);
    const roots = forest.map((t) => t.rootSessionId).sort();
    expect(roots).toEqual(["root1", "root2"]);
  });

  it("handles a sprout branching off a prune chain", () => {
    const entries: AuditEntry[] = [
      pruneEntry("root", "a", "2026-01-01T00:00:00.000Z"),
      sproutEntry("a", "clone1", "2026-01-01T01:00:00.000Z"),
    ];
    const forest = buildSessionForest(entries);
    expect(forest).toHaveLength(1);
    expect(forest[0].nodes).toHaveLength(2);
    const cloneNode = forest[0].nodes.find((n) => n.sessionId === "clone1");
    expect(cloneNode?.branchType).toBe("sprout");
    expect(cloneNode?.parentSessionId).toBe("a");
  });
});

describe("findPruneTrunk", () => {
  it("returns [] for a tree with no prune nodes", () => {
    const tree = { rootSessionId: "root", nodes: [{ sessionId: "clone1", parentSessionId: "root", branchType: "sprout" as const, timestamp: "t", removedOrBranchLength: 1, fruitOrHarvestLength: 1 }] };
    expect(findPruneTrunk(tree)).toEqual([]);
  });

  it("follows the prune chain in order, ignoring sprout siblings", () => {
    const entries: AuditEntry[] = [
      pruneEntry("root", "a", "2026-01-01T00:00:00.000Z"),
      sproutEntry("a", "clone1", "2026-01-01T00:30:00.000Z"),
      pruneEntry("a", "b", "2026-01-01T01:00:00.000Z"),
    ];
    const forest = buildSessionForest(entries);
    const trunk = findPruneTrunk(forest[0]);
    expect(trunk.map((n) => n.sessionId)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=mekiri-core -- sessionTree`
Expected: FAIL — `../src/sessionTree.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/mekiri-core/src/sessionTree.ts`:

```ts
import type { AuditEntry } from "./auditLog.js";

export interface SessionNode {
  sessionId: string;
  parentSessionId: string;
  branchType: "prune" | "sprout";
  timestamp: string;
  removedOrBranchLength: number;
  fruitOrHarvestLength: number;
}

export interface SessionTree {
  rootSessionId: string;
  nodes: SessionNode[];
}

function nodeFromEntry(entry: AuditEntry): SessionNode | undefined {
  if (entry.event === "prune") {
    return {
      sessionId: entry.newSessionId,
      parentSessionId: entry.sessionId,
      branchType: "prune",
      timestamp: entry.timestamp,
      removedOrBranchLength: entry.removedBranchLength,
      fruitOrHarvestLength: entry.fruitLength,
    };
  }
  if (entry.event === "sprout") {
    return {
      sessionId: entry.childSessionId,
      parentSessionId: entry.sessionId,
      branchType: "sprout",
      timestamp: entry.timestamp,
      removedOrBranchLength: entry.branchLength,
      fruitOrHarvestLength: entry.harvestLength,
    };
  }
  return undefined;
}

/**
 * Builds the forest of session trees recorded in a project's audit.jsonl.
 * Each prune/sprout entry is an edge parentSessionId -> sessionId. A tree's
 * root is a sessionId that appears as a parent but never as a child in this
 * log (i.e. it predates the observed history or is the very first session).
 * Independent, unrelated trees (separate work sessions over the project's
 * lifetime) are the normal case, not an edge case.
 */
export function buildSessionForest(entries: AuditEntry[]): SessionTree[] {
  const allNodes: SessionNode[] = [];
  for (const entry of entries) {
    const node = nodeFromEntry(entry);
    if (node) allNodes.push(node);
  }

  const nodeIds = new Set(allNodes.map((n) => n.sessionId));
  const childrenByParent = new Map<string, SessionNode[]>();
  for (const node of allNodes) {
    if (!childrenByParent.has(node.parentSessionId)) childrenByParent.set(node.parentSessionId, []);
    childrenByParent.get(node.parentSessionId)!.push(node);
  }

  const rootIds = new Set<string>();
  for (const node of allNodes) {
    if (!nodeIds.has(node.parentSessionId)) rootIds.add(node.parentSessionId);
  }

  const forest: SessionTree[] = [];
  for (const rootSessionId of rootIds) {
    const nodes: SessionNode[] = [];
    const queue = [...(childrenByParent.get(rootSessionId) ?? [])];
    while (queue.length > 0) {
      const node = queue.shift() as SessionNode;
      nodes.push(node);
      queue.push(...(childrenByParent.get(node.sessionId) ?? []));
    }
    forest.push({ rootSessionId, nodes });
  }
  return forest;
}

/**
 * The prune-only lineage from a tree's root to its current tip (the leaf
 * with no further prune child) -- see the design spec's VCL algorithm.
 * sprout children are never followed: a clone's content never occupied the
 * parent's context, so it isn't part of "the trunk" for this purpose.
 * A session can have at most one prune child (a pruned session is archived
 * and never pruned again), so this path is always unique.
 */
export function findPruneTrunk(tree: SessionTree): SessionNode[] {
  const pruneChildByParent = new Map<string, SessionNode>();
  for (const node of tree.nodes) {
    if (node.branchType === "prune") pruneChildByParent.set(node.parentSessionId, node);
  }
  const trunk: SessionNode[] = [];
  let currentId = tree.rootSessionId;
  while (pruneChildByParent.has(currentId)) {
    const next = pruneChildByParent.get(currentId) as SessionNode;
    trunk.push(next);
    currentId = next.sessionId;
  }
  return trunk;
}
```

Add to `packages/mekiri-core/src/index.ts`:

```ts
export { buildSessionForest, findPruneTrunk } from "./sessionTree.js";
export type { SessionNode, SessionTree } from "./sessionTree.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- sessionTree`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/sessionTree.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/sessionTree.test.ts
git commit -m "feat(mekiri-core): add sessionTree.ts to reconstruct the prune/sprout tree"
```

---

### Task 3: `virtualContextLifetime` formula

**Files:**
- Modify: `packages/mekiri-core/src/metrics.ts`
- Modify: `packages/mekiri-core/test/metrics.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Produces: `virtualContextLifetime(actualTurn: number, virtualTurn: number): number`, exported from `mekiri-core`. Task 5 calls this directly with the two indices it computes.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mekiri-core/test/metrics.test.ts`:

```ts
describe("virtualContextLifetime", () => {
  it("matches tz.md's own worked example (61 actual, 34 virtual -> ~79%)", () => {
    expect(virtualContextLifetime(61, 34)).toBeCloseTo(0.794, 2);
  });

  it("is 0 when actual equals virtual (no prune happened along the trunk)", () => {
    expect(virtualContextLifetime(10, 10)).toBe(0);
  });
});
```

(Add `virtualContextLifetime` to this test file's existing import from `../src/metrics.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=mekiri-core -- metrics`
Expected: FAIL — `virtualContextLifetime` is not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `packages/mekiri-core/src/metrics.ts` (after the existing `contextRecyclingRatio` function):

```ts
/** tz.md §12.2 — Virtual Context Lifetime = (actual - virtual) / virtual, as a fraction (e.g. 0.79 = 79%). */
export function virtualContextLifetime(actualTurn: number, virtualTurn: number): number {
  return (actualTurn - virtualTurn) / virtualTurn;
}
```

Add `virtualContextLifetime` to the existing export line in `packages/mekiri-core/src/index.ts` (currently `export { distillationRatio, branchCompression, lifetimeTokenSavings, contextRecyclingRatio } from "./metrics.js";`):

```ts
export { distillationRatio, branchCompression, lifetimeTokenSavings, contextRecyclingRatio, virtualContextLifetime } from "./metrics.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- metrics`
Expected: PASS (all `metrics.test.ts` tests, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/metrics.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/metrics.test.ts
git commit -m "feat(mekiri-core): add the virtualContextLifetime formula"
```

---

### Task 4: `metricsReport.ts` part 1 — Lifetime Token Savings + Context Recycling Ratio on real data

**Files:**
- Create: `packages/mekiri-core/src/metricsReport.ts`
- Test: `packages/mekiri-core/test/metricsReport.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `readSessionTranscript` (Task 1), `SessionTree`/`SessionNode` (Task 2), `lifetimeTokenSavings` (existing, `metrics.ts`), `PruneAuditEntry` (existing, `auditLog.ts`).
- Produces: `computeSubsequentRequestCount(dir, tree, fromSessionId): Promise<number>`, `PruneSavings` type, `computeLifetimeTokenSavingsForTree(dir, tree, entries): Promise<PruneSavings[]>`, `computeTotalContextProduced(dir, tree): Promise<number>` — all exported from `mekiri-core`. Task 6 imports and calls all three.

- [ ] **Step 1: Write the failing tests**

Create `packages/mekiri-core/test/metricsReport.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSubsequentRequestCount, computeLifetimeTokenSavingsForTree, computeTotalContextProduced } from "../src/metricsReport.js";
import { sanitizeDir } from "../src/sessionTranscript.js";
import { buildSessionForest } from "../src/sessionTree.js";
import type { AuditEntry, PruneAuditEntry } from "../src/auditLog.js";
import type { RawLine } from "../src/types.js";

const projectDir = "/fake/project";

async function writeFixtureTranscript(configDir: string, sessionId: string, userTurnCount: number): Promise<void> {
  const lines: RawLine[] = [];
  for (let i = 0; i < userTurnCount; i++) {
    lines.push({ type: "user", uuid: `u${i}`, parentUuid: null, isSidechain: false, message: { role: "user", content: `turn ${i}` } });
    lines.push({ type: "assistant", uuid: `a${i}`, parentUuid: `u${i}`, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  }
  const dirPath = path.join(configDir, "projects", sanitizeDir(projectDir));
  await mkdir(dirPath, { recursive: true });
  await writeFile(path.join(dirPath, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("metricsReport (LTS + CRR)", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-metricsreport-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  it("computeSubsequentRequestCount sums user turns across the whole subtree", async () => {
    const entries: AuditEntry[] = [
      { event: "prune", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "root", newSessionId: "a", noteType: "portal", removedBranchLength: 500, fruitLength: 50 },
      { event: "sprout", timestamp: "2026-01-01T01:00:00.000Z", sessionId: "a", childSessionId: "clone1", branchLength: 100, harvestLength: 20 },
    ];
    const forest = buildSessionForest(entries);
    await writeFixtureTranscript(configDir, "a", 3);
    await writeFixtureTranscript(configDir, "clone1", 2);

    const count = await computeSubsequentRequestCount(projectDir, forest[0], "a");
    expect(count).toBe(5); // 3 in "a" itself + 2 in its sprout descendant
  });

  it("computeLifetimeTokenSavingsForTree computes real savings per prune entry", async () => {
    const pruneEntry: PruneAuditEntry = {
      event: "prune",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "root",
      newSessionId: "a",
      noteType: "portal",
      removedBranchLength: 500,
      fruitLength: 50,
    };
    const forest = buildSessionForest([pruneEntry]);
    await writeFixtureTranscript(configDir, "a", 4);

    const results = await computeLifetimeTokenSavingsForTree(projectDir, forest[0], [pruneEntry]);
    expect(results).toHaveLength(1);
    expect(results[0].subsequentRequestCount).toBe(4);
    expect(results[0].savings).toBe(500 * 4);
  });

  it("computeTotalContextProduced sums transcript lengths across every node including the root", async () => {
    const entries: AuditEntry[] = [
      { event: "prune", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "root", newSessionId: "a", noteType: "portal", removedBranchLength: 500, fruitLength: 50 },
    ];
    const forest = buildSessionForest(entries);
    await writeFixtureTranscript(configDir, "root", 1);
    await writeFixtureTranscript(configDir, "a", 1);

    const rootLines = await import("../src/sessionTranscript.js").then((m) => m.readSessionTranscript(projectDir, "root"));
    const aLines = await import("../src/sessionTranscript.js").then((m) => m.readSessionTranscript(projectDir, "a"));
    const expectedTotal = JSON.stringify(rootLines).length + JSON.stringify(aLines).length;

    const total = await computeTotalContextProduced(projectDir, forest[0]);
    expect(total).toBe(expectedTotal);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: FAIL — `../src/metricsReport.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/mekiri-core/src/metricsReport.ts`:

```ts
import type { PruneAuditEntry } from "./auditLog.js";
import { lifetimeTokenSavings } from "./metrics.js";
import { readSessionTranscript } from "./sessionTranscript.js";
import type { SessionTree, SessionNode } from "./sessionTree.js";

async function countUserTurns(dir: string, sessionId: string): Promise<number> {
  const lines = await readSessionTranscript(dir, sessionId);
  return lines.filter((line) => line.type === "user").length;
}

function subtreeSessionIds(tree: SessionTree, fromSessionId: string): string[] {
  const childrenByParent = new Map<string, SessionNode[]>();
  for (const node of tree.nodes) {
    if (!childrenByParent.has(node.parentSessionId)) childrenByParent.set(node.parentSessionId, []);
    childrenByParent.get(node.parentSessionId)!.push(node);
  }
  const ids: string[] = [fromSessionId];
  const queue = [...(childrenByParent.get(fromSessionId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift() as SessionNode;
    ids.push(node.sessionId);
    queue.push(...(childrenByParent.get(node.sessionId) ?? []));
  }
  return ids;
}

/**
 * Counts real user turns across fromSessionId and its whole subtree
 * (both prune-continuations and sprout-offshoots -- a clone forked after
 * the prune being analyzed still would have needed to re-transmit the
 * removed content had it not been pruned, so its turns count too).
 */
export async function computeSubsequentRequestCount(dir: string, tree: SessionTree, fromSessionId: string): Promise<number> {
  const ids = subtreeSessionIds(tree, fromSessionId);
  const counts = await Promise.all(ids.map((id) => countUserTurns(dir, id)));
  return counts.reduce((sum, c) => sum + c, 0);
}

export interface PruneSavings {
  sessionId: string;
  newSessionId: string;
  subsequentRequestCount: number;
  savings: number;
}

export async function computeLifetimeTokenSavingsForTree(dir: string, tree: SessionTree, entries: PruneAuditEntry[]): Promise<PruneSavings[]> {
  const results: PruneSavings[] = [];
  for (const entry of entries) {
    const subsequentRequestCount = await computeSubsequentRequestCount(dir, tree, entry.newSessionId);
    results.push({
      sessionId: entry.sessionId,
      newSessionId: entry.newSessionId,
      subsequentRequestCount,
      savings: lifetimeTokenSavings(entry, subsequentRequestCount),
    });
  }
  return results;
}

export async function computeTotalContextProduced(dir: string, tree: SessionTree): Promise<number> {
  const allIds = [tree.rootSessionId, ...tree.nodes.map((n) => n.sessionId)];
  const lengths = await Promise.all(
    allIds.map(async (id) => {
      const lines = await readSessionTranscript(dir, id);
      return JSON.stringify(lines).length;
    }),
  );
  return lengths.reduce((sum, l) => sum + l, 0);
}
```

Add to `packages/mekiri-core/src/index.ts`:

```ts
export { computeSubsequentRequestCount, computeLifetimeTokenSavingsForTree, computeTotalContextProduced } from "./metricsReport.js";
export type { PruneSavings } from "./metricsReport.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/metricsReport.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/metricsReport.test.ts
git commit -m "feat(mekiri-core): compute real Lifetime Token Savings and Context Recycling Ratio inputs"
```

---

### Task 5: `metricsReport.ts` part 2 — Virtual Context Lifetime

**Files:**
- Modify: `packages/mekiri-core/src/metricsReport.ts`
- Modify: `packages/mekiri-core/test/metricsReport.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`

**Interfaces:**
- Consumes: `findLastCompactBoundaryIndex` (existing, `compactZone.ts`), `findPruneTrunk` (Task 2), `virtualContextLifetime` (Task 3), `readSessionTranscript` (Task 1).
- Produces: `VirtualContextLifetimeResult` type, `computeVirtualContextLifetime(dir, tree): Promise<VirtualContextLifetimeResult | undefined>` — exported from `mekiri-core`. Task 6 calls this directly.

This is the algorithmically riskiest task in this plan — the Global Constraints section above has the exact algorithm already worked out; implement it precisely as specified, do not re-derive it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mekiri-core/test/metricsReport.test.ts`. This new `describe` block is **self-contained** — it does NOT reuse the `configDir`/`beforeEach`/`afterEach` from the `"metricsReport (LTS + CRR)"` block Task 4 added (that block's `let configDir` is scoped to its own `describe`, not visible to a sibling `describe`), so it sets up its own temp `CLAUDE_CONFIG_DIR` the same way. Add `computeVirtualContextLifetime` and `SessionTree` to the existing imports from `../src/metricsReport.js` / `../src/sessionTree.js` at the top of the file if not already present:

```ts
function makeLine(uuid: string, isCompactSummary = false): RawLine {
  return {
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: false,
    isCompactSummary,
    message: { role: "user", content: `line ${uuid} `.padEnd(50, "x") },
  };
}

describe("computeVirtualContextLifetime", () => {
  let vclConfigDir: string;
  let originalConfigDir: string | undefined;
  const vclProjectDir = "/fake/vcl-project";

  beforeEach(async () => {
    vclConfigDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-vcl-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = vclConfigDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(vclConfigDir, { recursive: true, force: true });
  });

  async function writeFixtureLines(sessionId: string, lines: RawLine[]): Promise<void> {
    const dirPath = path.join(vclConfigDir, "projects", sanitizeDir(vclProjectDir));
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }

  it("returns undefined when the trunk tip never compacted", async () => {
    await writeFixtureLines("root", [makeLine("u0"), makeLine("u1")]); // no compact marker anywhere
    const tree: SessionTree = { rootSessionId: "root", nodes: [] };

    const result = await computeVirtualContextLifetime(vclProjectDir, tree);
    expect(result).toBeUndefined();
  });

  it("virtualTurn equals actualTurn when the trunk was never pruned (0% extension)", async () => {
    await writeFixtureLines("root", [makeLine("u0"), makeLine("u1", true), makeLine("u2")]);
    const tree: SessionTree = { rootSessionId: "root", nodes: [] };

    const result = await computeVirtualContextLifetime(vclProjectDir, tree);
    expect(result).toBeDefined();
    expect(result?.actualTurn).toBe(1);
    expect(result?.virtualTurn).toBe(1);
    expect(result?.lifetimeExtension).toBe(0);
  });

  it("reproduces tz.md's own worked pattern: no prior garbage means virtualTurn === actualTurn even with one trunk node", async () => {
    const lines: RawLine[] = [makeLine("u0"), makeLine("u1"), makeLine("u2"), makeLine("u3", true), makeLine("u4")];
    await writeFixtureLines("tip", lines);

    const threshold = JSON.stringify(lines.slice(0, 4)).length; // cumulative length through index 3
    const tree: SessionTree = {
      rootSessionId: "root",
      nodes: [
        { sessionId: "tip", parentSessionId: "root", branchType: "prune", timestamp: "t", removedOrBranchLength: threshold, fruitOrHarvestLength: 1 },
      ],
    };

    const result = await computeVirtualContextLifetime(vclProjectDir, tree);
    expect(result).toBeDefined();
    expect(result?.actualTurn).toBe(3);
    // priorGarbage here is 0 (trunk.slice(0,-1) is empty -- "tip" IS the only/last trunk node),
    // so this specific tree has no prior garbage and virtualTurn === actualTurn.
    expect(result?.virtualTurn).toBe(3);
    expect(result?.lifetimeExtension).toBe(0);
  });

  it("a real prior prune (two trunk nodes) pulls virtualTurn earlier than actualTurn", async () => {
    const lines: RawLine[] = [makeLine("u0"), makeLine("u1"), makeLine("u2", true), makeLine("u3")];
    await writeFixtureLines("tip", lines);

    const tree: SessionTree = {
      rootSessionId: "root",
      nodes: [
        { sessionId: "mid", parentSessionId: "root", branchType: "prune", timestamp: "t1", removedOrBranchLength: 10_000, fruitOrHarvestLength: 1 },
        { sessionId: "tip", parentSessionId: "mid", branchType: "prune", timestamp: "t2", removedOrBranchLength: 1, fruitOrHarvestLength: 1 },
      ],
    };

    const result = await computeVirtualContextLifetime(vclProjectDir, tree);
    expect(result).toBeDefined();
    expect(result?.actualTurn).toBe(2);
    // priorGarbage = 10_000 (the "mid" node's removal, "tip" itself excluded)
    // is large enough to guarantee the threshold is crossed at index 0.
    expect(result?.virtualTurn).toBe(0);
    expect(result?.lifetimeExtension).toBeGreaterThan(0);
  });
});
```

(Add `writeFile`, `mkdir`, `path`, `mkdtemp`, `rm`, `tmpdir`, `RawLine`, and `SessionTree` imports if not already present at the top of the test file from Task 4's additions — `SessionTree` comes from `../src/sessionTree.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: FAIL — `computeVirtualContextLifetime` is not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `packages/mekiri-core/src/metricsReport.ts` (add these two imports to the top of the file, alongside the existing ones):

```ts
import { findLastCompactBoundaryIndex } from "./compactZone.js";
import { findPruneTrunk } from "./sessionTree.js";
import { virtualContextLifetime } from "./metrics.js";
```

Then append:

```ts
export interface VirtualContextLifetimeResult {
  actualTurn: number;
  virtualTurn: number;
  lifetimeExtension: number;
}

/**
 * See design spec §4 and this plan's Global Constraints for the full
 * derivation. Only the trunk tip's own transcript is read -- no
 * multi-session concatenation needed. priorGarbage (every earlier prune's
 * removed length along the trunk, excluding the tip itself) is added as a
 * head start to the virtual cumulative-length walk instead of starting at
 * 0, which reproduces the same result as a full reconstruction with one
 * file read instead of N.
 */
export async function computeVirtualContextLifetime(dir: string, tree: SessionTree): Promise<VirtualContextLifetimeResult | undefined> {
  const trunk = findPruneTrunk(tree);
  const tipSessionId = trunk.length > 0 ? trunk[trunk.length - 1].sessionId : tree.rootSessionId;

  const tipTranscript = await readSessionTranscript(dir, tipSessionId);
  const actualTurn = findLastCompactBoundaryIndex(tipTranscript);
  if (actualTurn === -1) {
    return undefined;
  }

  // Per-line sum, not JSON.stringify(slice).length -- the array form adds
  // "[", "]", "," overhead the per-line virtualCumulative walk below never
  // accrues, which throws off the >= threshold crossing by one index. Found
  // and fixed during Task 5 implementation (verified by hand against this
  // plan's own worked test cases).
  const threshold = tipTranscript.slice(0, actualTurn + 1).reduce((sum, line) => sum + JSON.stringify(line).length, 0);
  const priorGarbage = trunk.slice(0, -1).reduce((sum, node) => sum + node.removedOrBranchLength, 0);

  let virtualCumulative = priorGarbage;
  let virtualTurn = tipTranscript.length;
  for (let i = 0; i < tipTranscript.length; i++) {
    virtualCumulative += JSON.stringify(tipTranscript[i]).length;
    if (virtualCumulative >= threshold) {
      virtualTurn = i;
      break;
    }
  }

  return {
    actualTurn,
    virtualTurn,
    lifetimeExtension: virtualContextLifetime(actualTurn, virtualTurn),
  };
}
```

Add to `packages/mekiri-core/src/index.ts`:

```ts
export { computeVirtualContextLifetime } from "./metricsReport.js";
export type { VirtualContextLifetimeResult } from "./metricsReport.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: PASS (all tests in this file, including the 4 new VCL ones — 7 total).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-core/src/metricsReport.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/metricsReport.test.ts
git commit -m "feat(mekiri-core): add computeVirtualContextLifetime"
```

---

### Task 6: Project-wide report + CLI + real dogfood run

**Files:**
- Modify: `packages/mekiri-core/src/metricsReport.ts`
- Modify: `packages/mekiri-core/test/metricsReport.test.ts`
- Modify: `packages/mekiri-core/src/index.ts`
- Create: `packages/mekiri-host/src/metricsCli.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5 (`readAuditLog` from the existing `auditLog.ts`, `buildSessionForest`, `distillationRatio`/`branchCompression`/`contextRecyclingRatio`, `computeLifetimeTokenSavingsForTree`, `computeTotalContextProduced`, `computeVirtualContextLifetime`).
- Produces: `TreeMetricsReport`, `ProjectMetricsReport` types and `computeProjectReport(dir: string): Promise<ProjectMetricsReport>`, exported from `mekiri-core`. `metricsCli.ts` is the terminal consumer — nothing later depends on it.

- [ ] **Step 1: Write the failing test**

Add to `packages/mekiri-core/test/metricsReport.test.ts`. This `describe` block is **self-contained** (doesn't reuse `configDir`/`vclConfigDir` from either sibling block) and deliberately does NOT create any session transcript fixture files — `readAuditLog`/`computeProjectReport` only need a real `.mekiri/audit.jsonl`, and the transcript-dependent fields (`totalLifetimeTokenSavings`, `totalContextProduced`, `virtualContextLifetime`) are expected to degrade gracefully to `0`/`undefined` via `readSessionTranscript`'s existing `[]`-on-missing-file behavior (already proven by Task 1's and Task 4/5's own tests) — this test is about the **aggregation logic**, not re-proving transcript reading. The real, transcript-backed proof that this all works together is Step 7's live dogfood run below, not a synthetic fixture. Add `computeProjectReport` to the existing import from `../src/metricsReport.js`:

```ts
describe("computeProjectReport", () => {
  it("returns an empty trees array when there is no audit history", async () => {
    const emptyProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-empty-project-"));
    try {
      const report = await computeProjectReport(emptyProjectDir);
      expect(report.trees).toEqual([]);
    } finally {
      await rm(emptyProjectDir, { recursive: true, force: true });
    }
  });

  it("assembles pruneCount/sproutCount/averages from a real audit log", async () => {
    const { appendAuditEntry } = await import("../src/auditLog.js");
    const realProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-real-project-"));
    try {
      await appendAuditEntry(realProjectDir, {
        event: "prune",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "root",
        newSessionId: "a",
        noteType: "portal",
        removedBranchLength: 500,
        fruitLength: 50,
      });

      const report = await computeProjectReport(realProjectDir);
      expect(report.trees).toHaveLength(1);
      expect(report.trees[0].rootSessionId).toBe("root");
      expect(report.trees[0].pruneCount).toBe(1);
      expect(report.trees[0].sproutCount).toBe(0);
      expect(report.trees[0].averageDistillationRatio).toBeCloseTo(500 / 50, 5);
      expect(report.trees[0].averageBranchCompression).toBeUndefined();
      // No session files exist anywhere for "root"/"a" in this test's real
      // filesystem/CLAUDE_CONFIG_DIR -- readSessionTranscript degrades to []
      // for both, so there's no real transcript data to multiply against
      // (subsequentRequestCount is 0, so totalLifetimeTokenSavings is 0).
      // totalContextProduced is NOT 0, though: it's JSON.stringify([]).length
      // (the 2-character string "[]") summed per node -- 2 nodes ("root",
      // "a") x 2 chars = 4. This is the correct, literal output for a tree
      // whose session files are missing, not a sign the computation is
      // broken. Step 7's live dogfood run is what actually proves the
      // transcript-backed numbers on real content.
      expect(report.trees[0].totalLifetimeTokenSavings).toBe(0);
      expect(report.trees[0].totalContextProduced).toBe(4);
      expect(report.trees[0].virtualContextLifetime).toBeUndefined();
    } finally {
      await rm(realProjectDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: FAIL — `computeProjectReport` is not exported yet.

- [ ] **Step 3: Implement `computeProjectReport`**

Add to `packages/mekiri-core/src/metricsReport.ts` (add these imports to the top of the file, alongside the existing ones):

```ts
import type { AuditEntry, PruneAuditEntry, SproutAuditEntry } from "./auditLog.js";
import { readAuditLog } from "./auditLog.js";
import { distillationRatio, branchCompression, contextRecyclingRatio } from "./metrics.js";
import { buildSessionForest } from "./sessionTree.js";
```

Then append:

```ts
function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface TreeMetricsReport {
  rootSessionId: string;
  pruneCount: number;
  sproutCount: number;
  averageDistillationRatio: number | undefined;
  averageBranchCompression: number | undefined;
  pruneSavings: PruneSavings[];
  totalLifetimeTokenSavings: number;
  totalContextProduced: number;
  contextRecyclingRatio: number;
  virtualContextLifetime: VirtualContextLifetimeResult | undefined;
}

export interface ProjectMetricsReport {
  trees: TreeMetricsReport[];
}

export async function computeProjectReport(dir: string): Promise<ProjectMetricsReport> {
  const entries = await readAuditLog(dir);
  const forest = buildSessionForest(entries);

  const trees: TreeMetricsReport[] = [];
  for (const tree of forest) {
    const nodeIds = new Set(tree.nodes.map((n) => n.sessionId));
    const treeEntries = entries.filter(
      (e): e is PruneAuditEntry | SproutAuditEntry =>
        (e.event === "prune" && nodeIds.has(e.newSessionId)) || (e.event === "sprout" && nodeIds.has(e.childSessionId)),
    );
    const pruneEntries = treeEntries.filter((e): e is PruneAuditEntry => e.event === "prune");
    const sproutEntries = treeEntries.filter((e): e is SproutAuditEntry => e.event === "sprout");

    const pruneSavings = await computeLifetimeTokenSavingsForTree(dir, tree, pruneEntries);
    const totalLifetimeTokenSavings = pruneSavings.reduce((sum, p) => sum + p.savings, 0);
    const totalContextProduced = await computeTotalContextProduced(dir, tree);
    const vcl = await computeVirtualContextLifetime(dir, tree);

    trees.push({
      rootSessionId: tree.rootSessionId,
      pruneCount: pruneEntries.length,
      sproutCount: sproutEntries.length,
      averageDistillationRatio: pruneEntries.length > 0 ? average(pruneEntries.map(distillationRatio)) : undefined,
      averageBranchCompression: sproutEntries.length > 0 ? average(sproutEntries.map(branchCompression)) : undefined,
      pruneSavings,
      totalLifetimeTokenSavings,
      totalContextProduced,
      contextRecyclingRatio: totalContextProduced > 0 ? contextRecyclingRatio(treeEntries, totalContextProduced) : 0,
      virtualContextLifetime: vcl,
    });
  }

  return { trees };
}
```

(This references `AuditEntry` type only to satisfy the `treeEntries` filter's type predicate — if TypeScript complains it's unused, keep it; it's part of the filter's return type annotation.)

Add to `packages/mekiri-core/src/index.ts`:

```ts
export { computeProjectReport } from "./metricsReport.js";
export type { TreeMetricsReport, ProjectMetricsReport } from "./metricsReport.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=mekiri-core -- metricsReport`
Expected: PASS (all tests in this file).

Then run the whole `mekiri-core` suite to confirm no regressions from the accumulated changes across this plan:

Run: `npm run test --workspace=mekiri-core`
Expected: PASS (all tests, no live API calls in this package — `mekiri-core` has none by design).

- [ ] **Step 5: Write the CLI**

Create `packages/mekiri-host/src/metricsCli.ts`:

```ts
import { computeProjectReport } from "mekiri-core";

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function printHumanReadable(report: Awaited<ReturnType<typeof computeProjectReport>>): void {
  if (report.trees.length === 0) {
    console.log("No session trees found in .mekiri/audit.jsonl -- nothing to report yet.");
    return;
  }
  for (const tree of report.trees) {
    console.log(`\nSession tree rooted at ${tree.rootSessionId}`);
    console.log(
      `  prune events: ${tree.pruneCount}` +
        (tree.averageDistillationRatio !== undefined ? ` (avg Distillation Ratio: ${tree.averageDistillationRatio.toFixed(2)}x)` : ""),
    );
    console.log(
      `  sprout events: ${tree.sproutCount}` +
        (tree.averageBranchCompression !== undefined ? ` (avg Branch Compression: ${tree.averageBranchCompression.toFixed(2)}x)` : ""),
    );
    console.log(`  Lifetime Token Savings: ${tree.totalLifetimeTokenSavings} chars`);
    console.log(`  Context Recycling Ratio: ${formatPercent(tree.contextRecyclingRatio)}`);
    if (tree.virtualContextLifetime) {
      console.log(
        `  Virtual Context Lifetime: actual turn ${tree.virtualContextLifetime.actualTurn}, virtual turn ${tree.virtualContextLifetime.virtualTurn} -- ${formatPercent(tree.virtualContextLifetime.lifetimeExtension)} extension`,
      );
    } else {
      console.log("  Virtual Context Lifetime: not enough data (trunk never compacted)");
    }
  }
}

async function main(): Promise<void> {
  const dirIndex = process.argv.indexOf("--dir");
  const dir = dirIndex !== -1 ? process.argv[dirIndex + 1] : process.cwd();
  const asJson = process.argv.includes("--json");

  const report = await computeProjectReport(dir);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReadable(report);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 6: Type-check**

Run: `npx tsc -p packages/mekiri-host/tsconfig.json --noEmit` from `packages/mekiri-host/`
Expected: no output, exit code 0.

Also type-check `mekiri-core` itself:

Run: `npx tsc -p packages/mekiri-core/tsconfig.json --noEmit` from `packages/mekiri-core/`
Expected: no output, exit code 0.

- [ ] **Step 7: Real dogfood run against this repo's own accumulated audit log**

This is the actual point of the whole feature — not a synthetic test, a real report on real project history. Run from `packages/mekiri-host/`:

```
npx tsx src/metricsCli.ts --dir /home/pol/dev/rollback
```

Report the exact output verbatim. If it errors (e.g. a real session file referenced by `.mekiri/audit.jsonl` was cleaned up or is otherwise missing), that's a real finding to report, not something to paper over — `readSessionTranscript`'s graceful `[]` fallback should keep the command from crashing even so, but note anything that looks wrong (e.g. a metric that's suspiciously `0` or `undefined` when you'd expect real data) rather than assuming it's fine.

Also run with `--json` once to confirm that path works too:

```
npx tsx src/metricsCli.ts --dir /home/pol/dev/rollback --json
```

- [ ] **Step 8: Commit**

```bash
git add packages/mekiri-core/src/metricsReport.ts packages/mekiri-core/src/index.ts packages/mekiri-core/test/metricsReport.test.ts packages/mekiri-host/src/metricsCli.ts
git commit -m "feat: add computeProjectReport and the metrics CLI"
```

---

## After this plan

Not covered here (see spec §7 "Вне скоупа"): integrating any of these metrics into `mekiri-tuning`'s own Trigger B (that skill is deliberately scoped to two metrics an agent computes by hand from one audit-log line, a different audience than this human-facing report); caching/persisting computed reports between runs (always recomputed postfactum, cheap at realistic `.mekiri/audit.jsonl` sizes); any graphing/visualization (text and JSON output only).
