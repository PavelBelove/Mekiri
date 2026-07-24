import type { RawLine } from "../../src/types.js";

let counter = 0;

export function resetUuidCounter(): void {
  counter = 0;
}

function nextUuid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function userLine(parentUuid: string | null, text: string): RawLine {
  return {
    type: "user",
    uuid: nextUuid("user"),
    parentUuid,
    isSidechain: false,
    message: { role: "user", content: text },
  };
}

export function assistantLine(
  parentUuid: string | null,
  text: string,
  opts: { isSidechain?: boolean } = {},
): RawLine {
  return {
    type: "assistant",
    uuid: nextUuid("asst"),
    parentUuid,
    isSidechain: opts.isSidechain ?? false,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** An assistant line whose only matching text lives in a `thinking` block, not `text`. */
export function assistantThinkingLine(parentUuid: string | null, thinkingText: string): RawLine {
  return {
    type: "assistant",
    uuid: nextUuid("asst"),
    parentUuid,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "thinking", text: thinkingText }] },
  };
}

export interface CompactPairResult {
  system: RawLine;
  summary: RawLine;
  lastUuid: string;
}

export function compactPair(parentUuid: string | null): CompactPairResult {
  const system: RawLine = {
    type: "system",
    compactMetadata: { trigger: "auto" },
  };
  const summaryUuid = nextUuid("compact-summary");
  const summary: RawLine = {
    type: "user",
    uuid: summaryUuid,
    parentUuid,
    isSidechain: false,
    isCompactSummary: true,
  };
  return { system, summary, lastUuid: summaryUuid };
}
