import type { BoundaryResult, RawLine } from "./types.js";
import { findLastCompactBoundaryIndex, preservedUuidsOfLastCompaction } from "./compactZone.js";

function messageContainsQuote(line: RawLine, quote: string): boolean {
  if (line.type !== "assistant" || line.isSidechain) return false;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.includes(quote));
}

export function findBoundary(lines: RawLine[], quote: string): BoundaryResult {
  const boundaryIdx = findLastCompactBoundaryIndex(lines);
  const searchStart = boundaryIdx + 1;
  // The verbatim stretch a mid-turn compaction kept is live, though it sits
  // before the summary on disk.
  const preserved = boundaryIdx >= 0 ? preservedUuidsOfLastCompaction(lines) : new Set<string>();
  const isLive = (i: number) => i >= searchStart || (lines[i].uuid !== undefined && preserved.has(lines[i].uuid!));

  const matches: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLive(i) && messageContainsQuote(line, quote) && line.uuid) {
      matches.push(line.uuid);
    }
  }

  if (matches.length === 1) {
    return { status: "ok", messageId: matches[0] };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", occurrences: matches.length };
  }

  if (boundaryIdx >= 0) {
    for (let i = 0; i < searchStart; i++) {
      if (!isLive(i) && messageContainsQuote(lines[i], quote)) {
        return { status: "in_compacted_zone", lastCompactMessageId: lines[boundaryIdx].uuid ?? "" };
      }
    }
  }

  return { status: "not_found" };
}
