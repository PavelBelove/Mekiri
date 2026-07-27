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

/** tz.md §12.2 — Virtual Context Lifetime = (actual - virtual) / virtual, as a fraction (e.g. 0.79 = 79%). */
export function virtualContextLifetime(actualTurn: number, virtualTurn: number): number {
  return (actualTurn - virtualTurn) / virtualTurn;
}
