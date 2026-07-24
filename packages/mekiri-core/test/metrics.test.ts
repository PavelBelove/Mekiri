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
