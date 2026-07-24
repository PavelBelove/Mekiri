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
