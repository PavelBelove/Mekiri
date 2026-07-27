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
