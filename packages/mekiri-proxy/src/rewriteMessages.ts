export interface RewriteRule {
  id: string;
  matchQuote: string;
}

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
function findAssistantTextIndex(messages: unknown[], quote: string): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    const m = asMessage(messages[i]);
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const hit = content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        (block as { text: string }).text.includes(quote)
    );
    if (hit) return i;
  }
  return undefined;
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
    const end = findPruneResultAnchor(messages, rule.id);
    if (end === undefined) continue; // this rule's own prune call hasn't reached this request's array yet
    const start = findAssistantTextIndex(messages, rule.matchQuote);
    if (start === undefined || start > end) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

export function rewriteMessages(messages: unknown[], rules: RewriteRule[] | undefined): unknown[] {
  if (!rules || rules.length === 0) return messages;
  const ranges = resolveRanges(messages, rules);
  if (ranges.length === 0) return messages;
  const excluded = new Set<number>();
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) excluded.add(i);
  }
  return messages.filter((_, i) => !excluded.has(i));
}
