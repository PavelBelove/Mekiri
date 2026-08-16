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
