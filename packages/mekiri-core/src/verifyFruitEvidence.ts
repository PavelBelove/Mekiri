import type { PortalFruit, RawLine } from "./types.js";

const MUTATING_TOOL_NAMES = new Set(["Write", "Edit", "NotebookEdit"]);

/** Raw shape of a tool_use content block, as it actually appears inside
 *  RawLine.message.content -- narrower than RawLine's own declared type,
 *  which only models {type, text}. */
interface ToolUseBlock {
  type: "tool_use";
  name?: string;
  input?: { file_path?: string; [key: string]: unknown };
}

function isToolUseBlock(block: { type: string }): block is ToolUseBlock {
  return block.type === "tool_use";
}

/** True if `absolutePath` (as reported by a Write/Edit/NotebookEdit tool_use,
 *  always absolute) refers to the same file as `relativePath` (as written in
 *  a fruit's files_touched[].path, typically relative to the project root). */
function pathsMatch(absolutePath: string, relativePath: string): boolean {
  if (absolutePath === relativePath) return true;
  return absolutePath.endsWith("/" + relativePath.replace(/^\.\//, ""));
}

/**
 * Existence check for `prune`/`tag` fruit: scans `range` (the transcript
 * slice about to be cut, or marked) for Write/Edit/NotebookEdit tool_use
 * blocks, and returns which of `fruit.files_touched[].path` have no
 * matching mutating tool_use anywhere in that range.
 *
 * Deliberately non-blocking evidence, not proof: a fruit legitimately
 * describing "already correct, no edit needed" has no tool_use to find, so
 * this can only flag for review, never reject a call.
 */
export function findUnverifiedPaths(range: RawLine[], fruit: PortalFruit): string[] {
  const touchedPaths = fruit.files_touched?.map((f) => f.path) ?? [];
  if (touchedPaths.length === 0) return [];

  const editedAbsolutePaths: string[] = [];
  for (const line of range) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      if (!block.name || !MUTATING_TOOL_NAMES.has(block.name)) continue;
      const filePath = block.input?.file_path;
      if (typeof filePath === "string") editedAbsolutePaths.push(filePath);
    }
  }

  return touchedPaths.filter(
    (relativePath) => !editedAbsolutePaths.some((absolutePath) => pathsMatch(absolutePath, relativePath)),
  );
}

/** Best-effort one-line label for a single tool_use block, used only to
 *  disambiguate identical-name calls in summarizeToolActivity's grouping
 *  (e.g. which file a Read/Edit touched) -- not a full argument dump. */
function toolCallLabel(block: ToolUseBlock): string {
  const input = block.input;
  if (!input) return "";
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof (input as { command?: unknown }).command === "string") {
    const command = (input as { command: string }).command;
    return command.length > 40 ? command.slice(0, 40) + "..." : command;
  }
  return "";
}

/**
 * Mechanical, agent-independent activity trace for `range` (the transcript
 * slice a prune call covers, kept or cut): counts every tool_use block by
 * tool name, with a representative label per distinct call. Unlike
 * kept_context/summary, this is derived straight from the transcript, so it
 * can't be thin or incomplete the way hand-written prose can -- it's a
 * factual backstop for the capsule/report record, not a replacement for the
 * fruit's own narrative.
 *
 * Returns "" for a range with no tool_use blocks at all (e.g. a pure
 * conversation turn) -- an empty activity log is itself informative, not an
 * error.
 */
export function summarizeToolActivity(range: RawLine[]): string {
  const countsByTool = new Map<string, number>();
  const labelsByTool = new Map<string, string[]>();

  for (const line of range) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      if (!block.name) continue;
      countsByTool.set(block.name, (countsByTool.get(block.name) ?? 0) + 1);
      const label = toolCallLabel(block);
      if (label) {
        const labels = labelsByTool.get(block.name) ?? [];
        labels.push(label);
        labelsByTool.set(block.name, labels);
      }
    }
  }

  const entries = [...countsByTool.entries()].map(([name, count]) => {
    const uniqueLabels = [...new Set(labelsByTool.get(name) ?? [])];
    const suffix = uniqueLabels.length > 0 ? `(${uniqueLabels.slice(0, 3).join(", ")}${uniqueLabels.length > 3 ? ", ..." : ""})` : "";
    return `${name}×${count}${suffix}`;
  });

  return entries.join(", ");
}
