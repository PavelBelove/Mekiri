import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSubsequentRequestCount, computeLifetimeTokenSavingsForTree, computeTotalContextProduced, computeVirtualContextLifetime } from "../src/metricsReport.js";
import { sanitizeDir } from "../src/sessionTranscript.js";
import { buildSessionForest } from "../src/sessionTree.js";
import type { SessionTree } from "../src/sessionTree.js";
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
