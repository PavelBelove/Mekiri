import type { BoundaryResult, RawLine } from "./types.js";
import { findLastCompactBoundaryIndex, preservedUuidsOfLastCompaction } from "./compactZone.js";

/** Where a quote is looked for inside an assistant message's content:
 *  its text blocks, or -- as a fallback -- the string inputs of its tool
 *  calls. The fallback exists because Claude Code drops a text block that
 *  sits between two thinking blocks (thinking -> text -> thinking ->
 *  tool_use) from both its .jsonl and the history it resends: the agent saw
 *  that text, quotes it, and it's nowhere. A tool call's own inputs (a Bash
 *  `description`, say) always survive, at the same boundary. */
export type QuoteScope = "text" | "tool_input";

function stringsIn(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

// Any Mekiri server's tools (mcp__mekiri-proxy__*, mekiri-host's mcp__mekiri__*)
// and a bare `prune`.
function isMekiriToolName(name: unknown): boolean {
  return typeof name === "string" && (name.includes("mekiri") || /(^|__)prune$/.test(name));
}

/** Shared by findBoundary (validation against the transcript on disk) and
 *  mekiri-proxy's rewriteMessages (the actual cut against the wire array), so
 *  a quote prune accepted is always one the cut can find. Mekiri's own tool
 *  calls are never matched: every past prune carries its quote in its input,
 *  and a nested cut could otherwise land on the prune call itself. */
export function contentContainsQuote(content: unknown, quote: string, scope: QuoteScope): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block !== "object" || block === null) return false;
    const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
    if (scope === "text") return b.type === "text" && typeof b.text === "string" && b.text.includes(quote);
    if (b.type !== "tool_use" || isMekiriToolName(b.name)) return false;
    return stringsIn(b.input, []).some((s) => s.includes(quote));
  });
}

function messageContainsQuote(line: RawLine, quote: string, scope: QuoteScope): boolean {
  if (line.type !== "assistant" || line.isSidechain) return false;
  return contentContainsQuote(line.message?.content, quote, scope);
}

function findBoundaryIn(lines: RawLine[], quote: string, scope: QuoteScope): BoundaryResult {
  const boundaryIdx = findLastCompactBoundaryIndex(lines);
  const searchStart = boundaryIdx + 1;
  // The verbatim stretch a mid-turn compaction kept is live, though it sits
  // before the summary on disk.
  const preserved = boundaryIdx >= 0 ? preservedUuidsOfLastCompaction(lines) : new Set<string>();
  const isLive = (i: number) => i >= searchStart || (lines[i].uuid !== undefined && preserved.has(lines[i].uuid!));

  const matches: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLive(i) && messageContainsQuote(line, quote, scope) && line.uuid) {
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
      if (!isLive(i) && messageContainsQuote(lines[i], quote, scope)) {
        return { status: "in_compacted_zone", lastCompactMessageId: lines[boundaryIdx].uuid ?? "" };
      }
    }
  }

  return { status: "not_found" };
}

/** Text first; tool inputs only when no text anywhere holds the quote, so a
 *  quote that used to resolve never turns ambiguous against a file some later
 *  Write happened to contain. */
export function findBoundary(lines: RawLine[], quote: string): BoundaryResult {
  const inText = findBoundaryIn(lines, quote, "text");
  return inText.status === "not_found" ? findBoundaryIn(lines, quote, "tool_input") : inText;
}
