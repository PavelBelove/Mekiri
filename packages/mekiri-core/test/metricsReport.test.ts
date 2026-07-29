import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSubsequentRequestCount, computeLifetimeTokenSavingsForTree, computeTotalContextProduced, computeVirtualContextLifetime, computeProjectReport } from "../src/metricsReport.js";
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

  it("computeLifetimeTokenSavingsForTree skips wire-level prune entries (no newSessionId)", async () => {
    // A wire-level prune (mekiri-proxy) never forks a new session, so it has
    // no newSessionId and no tree node to measure subsequent-request savings
    // against. It must be skipped without affecting the host-style prune
    // entry alongside it in the same entries array.
    const hostPrune: PruneAuditEntry = {
      event: "prune",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "root",
      newSessionId: "a",
      noteType: "portal",
      removedBranchLength: 500,
      fruitLength: 50,
    };
    const wirePrune: PruneAuditEntry = {
      event: "prune",
      timestamp: "2026-01-01T00:30:00.000Z",
      sessionId: "a",
      noteType: "portal",
      removedBranchLength: 200,
      fruitLength: 20,
    };
    const forest = buildSessionForest([hostPrune]);
    await writeFixtureTranscript(configDir, "a", 4);

    const results = await computeLifetimeTokenSavingsForTree(projectDir, forest[0], [hostPrune, wirePrune]);
    expect(results).toHaveLength(1);
    expect(results[0].newSessionId).toBe("a");
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

  it("excludes a wire-level prune entry (no newSessionId) from pruneCount and tree metrics", async () => {
    // Mixes a host-style prune (has newSessionId, forks a tree node) with a
    // wire-level prune (mekiri-proxy, no newSessionId, no fork) in the same
    // audit log. The wire-level entry must not crash computeProjectReport,
    // must not appear as a tree node, and must not be counted in pruneCount.
    const { appendAuditEntry } = await import("../src/auditLog.js");
    const realProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-wire-prune-project-"));
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
      await appendAuditEntry(realProjectDir, {
        event: "prune",
        timestamp: "2026-01-01T00:30:00.000Z",
        sessionId: "a",
        noteType: "portal",
        removedBranchLength: 200,
        fruitLength: 20,
      });

      const report = await computeProjectReport(realProjectDir);
      expect(report.trees).toHaveLength(1);
      expect(report.trees[0].rootSessionId).toBe("root");
      expect(report.trees[0].pruneCount).toBe(1);
      expect(report.trees[0].pruneSavings).toHaveLength(1);
      expect(report.trees[0].pruneSavings[0].newSessionId).toBe("a");
    } finally {
      await rm(realProjectDir, { recursive: true, force: true });
    }
  });
});
