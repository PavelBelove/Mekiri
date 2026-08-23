import type { RawLine } from "./types.js";

type ContentBlock = { type: string; text?: string; [key: string]: unknown };

function blockToText(block: ContentBlock): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "?";
    let input: string;
    try {
      input = JSON.stringify(block.input);
    } catch {
      input = String(block.input);
    }
    return `[tool_use: ${name} ${input}]`;
  }
  if (block.type === "tool_result") {
    const content = block.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c) => (typeof c === "string" ? c : ((c as ContentBlock).text ?? ""))).join("\n")
          : "";
    return `[tool_result: ${text}]`;
  }
  return `[${block.type}]`;
}

/**
 * Renders a raw transcript slice (as returned by readSessionTranscript) into
 * plain readable text -- graft's raw-fetch output. Only user/assistant lines
 * carry conversational content; everything else (summaries, meta lines) is
 * skipped rather than guessed at. Reuses RawLine's existing content-block
 * shape (mirrors quoteMatcher.ts's parsing) instead of a new parser.
 */
export function renderRawLines(lines: RawLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (typeof content === "string") {
      if (content.trim() !== "") parts.push(`[${role}] ${content}`);
    } else if (Array.isArray(content)) {
      const text = content.map((block) => blockToText(block as ContentBlock)).join("\n");
      if (text.trim() !== "") parts.push(`[${role}] ${text}`);
    }
  }
  return parts.join("\n\n");
}
