import { promises as fs } from "node:fs";
import path from "node:path";
import type { RawLine } from "../../src/types.js";

/**
 * Mirrors Claude Code's project-directory sanitization: replace every
 * non-alphanumeric character with a dash.
 *
 * NOTE: this differs from the original design assumption ("replace every
 * `/` with `-`"). Reading the installed SDK's compiled JS
 * (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs, function `us`)
 * shows the real rule is `dir.replace(/[^a-zA-Z0-9]/g, "-")` (with a
 * 200-char truncation + hash suffix for very long paths, not reproduced
 * here since it never triggers for our temp-dir paths). For the paths
 * used in this test file the two rules happen to coincide (mkdtemp
 * suffixes are alphanumeric and the only other character present is the
 * literal "-" in the prefix, which maps to itself), but the regex form is
 * the one that actually matches the SDK, so it's what we encode here.
 */
export function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

export function sessionFilePath(configDir: string, dir: string, sessionId: string): string {
  return path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
}

export async function writeSessionFile(
  configDir: string,
  dir: string,
  sessionId: string,
  lines: RawLine[],
): Promise<void> {
  const filePath = sessionFilePath(configDir, dir, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(filePath, content, "utf8");
}

export async function readSessionFile(configDir: string, dir: string, sessionId: string): Promise<RawLine[]> {
  const filePath = sessionFilePath(configDir, dir, sessionId);
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawLine);
}

export async function sessionFileExists(configDir: string, dir: string, sessionId: string): Promise<boolean> {
  try {
    await fs.access(sessionFilePath(configDir, dir, sessionId));
    return true;
  } catch {
    return false;
  }
}
