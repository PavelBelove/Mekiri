export interface RewriteRule {
  id: string;
  matchQuote: string;
  /** Set for Stop-forced prune calls (see bin/stop-hook.ts / hookState.ts's
   *  stopBoundary): the verbatim report the agent just wrote, which must
   *  survive the cut even though it sits right before this rule's own
   *  tool_use anchor with nothing (no user message) separating them.
   *  When present, resolveRanges pulls the cut range's end back to just
   *  before the last assistant message containing this text instead of the
   *  tool_use anchor. */
  preserveFromQuote?: string;
}

import { contentContainsQuote } from "mekiri-core";
import type { QuoteScope } from "mekiri-core";
import { applyReset, isResetRule } from "./contextReset.js";
import type { ResetRule } from "./contextReset.js";

/** Everything stored per session in rules.json: prune cuts and context resets. */
export type SessionRule = RewriteRule | ResetRule;

interface MessageShape {
  role?: string;
  content?: unknown;
}

function asMessage(m: unknown): MessageShape {
  return (m ?? {}) as MessageShape;
}

// Resolve every boundary fresh against whatever messages[] array we're
// actually given -- see docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md.
// A transcript-derived numeric index does not reliably correspond to a
// position in the real outbound API request array (mid-conversation
// role:"system" injections and merged thinking+tool_use pairs both cause
// the arrays to diverge), so we content-match against the real array
// instead of trusting a precomputed guess.
function findAssistantIndex(messages: unknown[], quote: string, scope: QuoteScope): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    const m = asMessage(messages[i]);
    if (m.role === "assistant" && contentContainsQuote(m.content, quote, scope)) return i;
  }
  return undefined;
}

// Text first, then tool-call inputs -- the same order as mekiri-core's
// findBoundary, which validated this quote (see contentContainsQuote for why
// a quote can live only in a tool call's input).
function findAssistantTextIndex(messages: unknown[], quote: string): number | undefined {
  return findAssistantIndex(messages, quote, "text") ?? findAssistantIndex(messages, quote, "tool_input");
}

// Same matching predicate as findAssistantTextIndex, but searches backward
// from just before `beforeIndex` (the rule's own tool_use anchor) instead of
// forward from the start of the array. Forward search would risk matching an
// older, coincidentally-similar assistant message deeper in history instead
// of the report that was actually just written for this specific prune call.
function findLastAssistantIndexBefore(
  messages: unknown[],
  quote: string,
  beforeIndex: number,
  scope: QuoteScope,
): number | undefined {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const m = asMessage(messages[i]);
    if (m.role === "assistant" && contentContainsQuote(m.content, quote, scope)) return i;
  }
  return undefined;
}

function findLastAssistantTextIndexBefore(messages: unknown[], quote: string, beforeIndex: number): number | undefined {
  return (
    findLastAssistantIndexBefore(messages, quote, beforeIndex, "text") ??
    findLastAssistantIndexBefore(messages, quote, beforeIndex, "tool_input")
  );
}

function getToolUseBlocks(message: unknown): { id: string; name: string }[] {
  const m = asMessage(message);
  if (m.role !== "assistant") return [];
  const content = m.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is { type: string; id: string; name: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use"
  );
}

// Real traffic never calls a tool named bare "prune" -- the SDK/MCP layer
// qualifies it as mcp__<server-name>__prune (e.g. mcp__mekiri-proxy__prune
// for this package's own MCP server, mcp__mekiri__prune for mekiri-host's
// in-process SDK server). Match on the qualified suffix so this doesn't
// silently break again if a server gets renamed; bare "prune" is still
// accepted for synthetic/test fixtures.
function isPruneToolName(name: string): boolean {
  return name === "prune" || name.endsWith("__prune");
}

function getToolResultBlocks(message: unknown): unknown[] {
  const m = asMessage(message);
  if (m.role !== "user") return [];
  const content = m.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block) => typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result"
  );
}

// The end of a cut range is anchored to the prune tool call itself, not to
// matchQuote text -- two different prune calls in one session could
// plausibly quote textually identical content, which would make a
// text-based anchor ambiguous. The tool_use/tool_result pair for this
// specific prune call is real content the API already round-trips through
// conversation history, and rule.id (echoed back inside the tool_result by
// mcpServer.ts) makes it uniquely identifiable. This pair is deliberately
// NOT excluded from the output -- it's the human-visible anchor carrying
// the distillate.
function findPruneResultAnchor(messages: unknown[], ruleId: string): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    const pruneCalls = getToolUseBlocks(messages[i]).filter((b) => isPruneToolName(b.name));
    if (pruneCalls.length === 0) continue;
    const toolResults = getToolResultBlocks(messages[i + 1]);
    for (const tr of toolResults) {
      const toolUseId = (tr as { tool_use_id?: string }).tool_use_id;
      if (!pruneCalls.some((call) => call.id === toolUseId)) continue;
      if (JSON.stringify(tr).includes(ruleId)) return i;
    }
  }
  return undefined;
}

interface ResolvedRange {
  start: number;
  end: number;
}

// Each rule resolves independently against the full array -- deliberately
// not excluding ranges already cut by earlier rules from the search space.
// This lets a later, longer-reaching prune swallow an earlier prune's own
// anchor for free (its indices just end up inside this range's [start,end)
// too), which is the whole point of the cumulative model: nothing needs to
// special-case "does this range contain another rule's marker".
function resolveRanges(messages: unknown[], rules: RewriteRule[]): ResolvedRange[] {
  const ranges: ResolvedRange[] = [];
  for (const rule of rules) {
    const anchorEnd = findPruneResultAnchor(messages, rule.id);
    if (anchorEnd === undefined) continue; // this rule's own prune call hasn't reached this request's array yet
    let end = anchorEnd;
    if (rule.preserveFromQuote) {
      const reportIdx = findLastAssistantTextIndexBefore(messages, rule.preserveFromQuote, anchorEnd);
      if (reportIdx !== undefined) end = Math.min(end, reportIdx);
    }
    const start = findAssistantTextIndex(messages, rule.matchQuote);
    if (start === undefined || start > end) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

/** Indices of `messages` removed by the prune rules among `rules`. */
export function computeExcluded(messages: unknown[], rules: SessionRule[]): Set<number> {
  const pruneRules = rules.filter((r): r is RewriteRule => !isResetRule(r));
  const excluded = new Set<number>();
  for (const range of resolveRanges(messages, pruneRules)) {
    for (let i = range.start; i < range.end; i++) excluded.add(i);
  }
  return excluded;
}

export function rewriteMessages(messages: unknown[], rules: SessionRule[] | undefined): unknown[] {
  if (!rules || rules.length === 0) return messages;
  const excluded = computeExcluded(messages, rules);
  // Prune cuts first, then the latest reset on top: a prune range that spans
  // the reset boundary still cuts its part of the kept tail.
  const resets = rules.filter(isResetRule);
  if (resets.length > 0) return applyReset(messages, excluded, resets[resets.length - 1]);
  if (excluded.size === 0) return messages;
  return messages.filter((_, i) => !excluded.has(i));
}
