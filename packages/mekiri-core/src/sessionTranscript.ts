import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RawLine } from "./types.js";

// Mirrors Claude Code's project-directory sanitization: replace every
// non-alphanumeric character with "-". Verified against the compiled SDK
// (originally established in mekiri-host's test fixtures); canonicalized
// here so production code and test fixtures share exactly one
// implementation instead of two copies drifting apart.
export function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

/**
 * Reads a real, already-recorded session transcript from disk --
 * $CLAUDE_CONFIG_DIR/projects/<sanitizeDir(dir)>/<sessionId>.jsonl, falling
 * back to ~/.claude when CLAUDE_CONFIG_DIR is unset. Returns [] (not a
 * throw) when the file doesn't exist, mirroring readAuditLog's convention.
 */
export async function readSessionTranscript(dir: string, sessionId: string): Promise<RawLine[]> {
  const filePath = path.join(resolveConfigDir(), "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RawLine);
  } catch {
    return [];
  }
}
