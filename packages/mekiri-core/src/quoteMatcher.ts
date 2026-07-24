import type { BoundaryResult, RawLine } from "./types.js";
import { findLastCompactBoundaryIndex } from "./compactZone.js";

function messageContainsQuote(line: RawLine, quote: string): boolean {
  if (line.type !== "assistant" || line.isSidechain) return false;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.includes(quote));
}

export function findBoundary(lines: RawLine[], quote: string): BoundaryResult {
  const boundaryIdx = findLastCompactBoundaryIndex(lines);
  const searchStart = boundaryIdx + 1;

  const matches: string[] = [];
  for (let i = searchStart; i < lines.length; i++) {
    const line = lines[i];
    if (messageContainsQuote(line, quote) && line.uuid) {
      matches.push(line.uuid);
    }
  }

  if (matches.length === 1) {
    return { status: "ok", uuid: matches[0] };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", occurrences: matches.length };
  }

  if (boundaryIdx >= 0) {
    for (let i = 0; i < searchStart; i++) {
      if (messageContainsQuote(lines[i], quote)) {
        return { status: "in_compacted_zone", lastCompactUuid: lines[boundaryIdx].uuid ?? "" };
      }
    }
  }

  return { status: "not_found" };
}
