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

/**
 * uuids of the messages the last compaction kept verbatim. When auto-compaction
 * fires mid-turn, Claude Code keeps the in-progress stretch in the live context
 * as-is, but on disk those lines stay BEFORE the summary line -- only the
 * `compact_boundary` system line's `compactMetadata.preservedMessages` says they
 * are still live. Without this, a quote from that stretch looks compacted away.
 */
export function preservedUuidsOfLastCompaction(lines: RawLine[]): Set<string> {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type !== "system" || line.subtype !== "compact_boundary") continue;
    const preserved = (line.compactMetadata as { preservedMessages?: { uuids?: unknown; allUuids?: unknown } } | undefined)
      ?.preservedMessages;
    const uuids = Array.isArray(preserved?.allUuids) ? preserved.allUuids : Array.isArray(preserved?.uuids) ? preserved.uuids : [];
    return new Set(uuids.filter((u): u is string => typeof u === "string"));
  }
  return new Set();
}
