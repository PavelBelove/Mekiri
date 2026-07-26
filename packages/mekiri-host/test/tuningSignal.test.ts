import { describe, it, expect } from "vitest";
import { computeTuningSignalContext } from "../src/tuningSignal.js";
import type { AuditEntry, PruneAuditEntry, SproutAuditEntry, ConfigureAuditEntry } from "mekiri-core";

function pruneEntry(removedBranchLength: number, fruitLength: number): PruneAuditEntry {
  return {
    event: "prune",
    timestamp: "2026-07-26T00:00:00.000Z",
    sessionId: "s1",
    newSessionId: "s2",
    noteType: "portal",
    removedBranchLength,
    fruitLength,
  };
}

function sproutEntry(branchLength: number, harvestLength: number): SproutAuditEntry {
  return {
    event: "sprout",
    timestamp: "2026-07-26T00:00:00.000Z",
    sessionId: "s1",
    childSessionId: "s3",
    branchLength,
    harvestLength,
  };
}

function configureEntry(): ConfigureAuditEntry {
  return {
    event: "configure_mekiri",
    timestamp: "2026-07-26T00:00:00.000Z",
    reason: "test",
    patch: {},
  };
}

describe("computeTuningSignalContext", () => {
  it("returns undefined for an empty log", () => {
    expect(computeTuningSignalContext([])).toBeUndefined();
  });

  it("returns undefined when there are fewer than 3 prune entries and fewer than 2 sprout entries", () => {
    const entries: AuditEntry[] = [pruneEntry(100, 80), sproutEntry(100, 80)];
    expect(computeTuningSignalContext(entries)).toBeUndefined();
  });

  it("returns undefined when there are enough entries but the ratios are healthy (>= threshold)", () => {
    const entries: AuditEntry[] = [
      pruneEntry(1000, 100), // 10x
      pruneEntry(1000, 100),
      pruneEntry(1000, 100),
    ];
    expect(computeTuningSignalContext(entries)).toBeUndefined();
  });

  it("signals when the last 3 prune entries average Distillation Ratio below 2x", () => {
    const entries: AuditEntry[] = [
      pruneEntry(100, 80), // 1.25x
      pruneEntry(100, 80),
      pruneEntry(100, 80),
    ];
    const result = computeTuningSignalContext(entries);
    expect(result).toBeDefined();
    expect(result).toContain("Distillation Ratio");
    expect(result).toContain("mekiri-tuning");
  });

  it("signals when the last 2 sprout entries average Branch Compression below 2x", () => {
    const entries: AuditEntry[] = [sproutEntry(100, 80), sproutEntry(100, 80)];
    const result = computeTuningSignalContext(entries);
    expect(result).toBeDefined();
    expect(result).toContain("Branch Compression");
    expect(result).toContain("mekiri-tuning");
  });

  it("does not let a healthy 4th-from-last prune entry rescue a low 3-entry average -- only the last 3 count", () => {
    const entries: AuditEntry[] = [
      pruneEntry(1000, 100), // 10x, healthy, but 4th-from-last -- must be ignored
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      pruneEntry(100, 80),
    ];
    expect(computeTuningSignalContext(entries)).toBeDefined();
  });

  it("anti-nag: suppresses a signal whose triggering entries are all before the last configure_mekiri", () => {
    const entries: AuditEntry[] = [
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      configureEntry(),
    ];
    expect(computeTuningSignalContext(entries)).toBeUndefined();
  });

  it("treats a zero-denominator entry in the window as not-enough-valid-data, not as a healthy Infinity ratio", () => {
    const entries: AuditEntry[] = [
      pruneEntry(1000, 100), // 10x, healthy
      pruneEntry(1000, 100), // 10x, healthy
      pruneEntry(500, 0), // fruitLength: 0 -> ratio is Infinity, a degenerate entry, not a healthy one
    ];
    expect(computeTuningSignalContext(entries)).toBeUndefined();
  });

  it("does not let an older entry slide into the window to replace a degenerate one -- the last 3 raw entries must all be valid", () => {
    const entries: AuditEntry[] = [
      pruneEntry(100, 80), // 1.25x, bad, 5th-from-last -- must NOT be pulled in to complete the window
      pruneEntry(100, 80), // 1.25x, bad, 4th-from-last -- must NOT be pulled in to complete the window
      pruneEntry(100, 80), // 1.25x, bad, but part of the raw last-3 window
      pruneEntry(100, 80), // 1.25x, bad, but part of the raw last-3 window
      pruneEntry(500, 0), // fruitLength: 0 -> degenerate, and the actual last entry
    ];
    // A naive "filter out non-finite ratios, then take the last 3" implementation would drop the
    // degenerate entry and slide the 4th-from-last (also 1.25x) into the window, wrongly averaging
    // to 1.25x and signaling. The correct fix takes the raw last 3 entries first (two 1.25x entries
    // plus the degenerate one), filters, gets only 2 valid entries, and reports "not enough data".
    expect(computeTuningSignalContext(entries)).toBeUndefined();
  });

  it("anti-nag: still signals a NEW low-ratio run that occurs after configure_mekiri", () => {
    const entries: AuditEntry[] = [
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      configureEntry(),
      pruneEntry(100, 80),
      pruneEntry(100, 80),
      pruneEntry(100, 80),
    ];
    expect(computeTuningSignalContext(entries)).toBeDefined();
  });
});
