import type { AuditEntry, PruneAuditEntry, SproutAuditEntry } from "./auditLog.js";

/** tz.md §12.2 — Distillation Ratio = removed branch length / fruit length.
 *  Only meaningful for a cut entry -- callers filter to those upstream
 *  (sessionTree.ts's nodeFromEntry only builds a tree node for parts
 *  including "cut", where removedBranchLength is always set). */
export function distillationRatio(entry: PruneAuditEntry): number {
  if (entry.removedBranchLength === undefined) {
    throw new Error("distillationRatio: entry has no removedBranchLength (not a cut prune)");
  }
  return entry.removedBranchLength / entry.fruitLength;
}

/** tz.md §12.2 — Branch Compression = branch length / harvest length. */
export function branchCompression(entry: SproutAuditEntry): number {
  return entry.branchLength / entry.harvestLength;
}

/** tz.md §12.2 — Lifetime Token Savings = removed length * subsequent request count. */
export function lifetimeTokenSavings(entry: PruneAuditEntry, subsequentRequestCount: number): number {
  if (entry.removedBranchLength === undefined) {
    throw new Error("lifetimeTokenSavings: entry has no removedBranchLength (not a cut prune)");
  }
  return entry.removedBranchLength * subsequentRequestCount;
}

function branchLengthOf(entry: AuditEntry): number {
  if (entry.event === "prune") return entry.removedBranchLength ?? 0;
  if (entry.event === "sprout") return entry.branchLength;
  return 0;
}

/** tz.md §12.2 — Context Recycling Ratio = sum of removed/branch lengths / total context produced. */
export function contextRecyclingRatio(entries: AuditEntry[], totalContextProduced: number): number {
  const recycled = entries.reduce((sum, entry) => sum + branchLengthOf(entry), 0);
  return recycled / totalContextProduced;
}

/** tz.md §12.2 — Virtual Context Lifetime = (actual - virtual) / virtual, as a fraction (e.g. 0.79 = 79%). */
export function virtualContextLifetime(actualTurn: number, virtualTurn: number): number {
  return (actualTurn - virtualTurn) / virtualTurn;
}
