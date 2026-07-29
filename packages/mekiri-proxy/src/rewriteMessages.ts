export interface RewriteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RewriteRule {
  matchQuote: string;
  replacement: RewriteMessage[];
}

// Resolve the cut position fresh against whatever messages[] array we're
// actually given -- see docs/superpowers/specs/2026-07-29-mekiri-proxy-boundary-finding.md.
// A transcript-derived numeric index does not reliably correspond to a
// position in the real outbound API request array (mid-conversation
// role:"system" injections and merged thinking+tool_use pairs both cause
// the arrays to diverge), so we content-match against the real array
// instead of trusting a precomputed guess.
function findMatchIndex(messages: unknown[], quote: string): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
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

export function rewriteMessages(messages: unknown[], rule: RewriteRule | undefined): unknown[] {
  if (!rule) return messages;
  const idx = findMatchIndex(messages, rule.matchQuote);
  if (idx === undefined) return messages; // quote not (yet) present in this request's array -- forward unchanged rather than guess
  const kept = messages.slice(idx + 1);
  return [...rule.replacement, ...kept];
}
