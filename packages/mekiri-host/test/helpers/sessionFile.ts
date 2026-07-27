import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sanitizeDir } from "mekiri-core";
import type { RawLine } from "mekiri-core";

export async function writeSessionFile(configDir: string, dir: string, sessionId: string, lines: RawLine[]): Promise<void> {
  const filePath = path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

// The SDK resolves auth credentials from CLAUDE_CONFIG_DIR/.credentials.json
// (falling back to ~/.claude when CLAUDE_CONFIG_DIR is unset). Any test that
// overrides CLAUDE_CONFIG_DIR to an empty temp dir (needed so session-file
// reads/writes stay isolated to a fixture) breaks real query() calls with
// "Not logged in" unless the real credentials file is copied alongside the
// fixture — found by live dogfooding during the sprout tool's own test.
// Best-effort: if the real file is missing (e.g. CI using a different auth
// mechanism), let query() surface its own error rather than hiding it here.
export async function copyRealCredentials(configDir: string): Promise<void> {
  try {
    await fs.copyFile(path.join(homedir(), ".claude", ".credentials.json"), path.join(configDir, ".credentials.json"));
  } catch {
    // no credentials file to copy; fall through and let query() report auth failure
  }
}
