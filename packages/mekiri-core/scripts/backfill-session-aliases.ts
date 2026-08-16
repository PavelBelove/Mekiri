#!/usr/bin/env node
/**
 * One-off (but idempotent, safe to re-run) backfill: creates human-readable
 * session aliases and regenerates .mekiri/sessions-index.md for sessions
 * that were recorded before ensureSessionAlias/writeSessionsIndex existed.
 *
 * Usage: npx tsx packages/mekiri-core/scripts/backfill-session-aliases.ts [project-dir]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureSessionAlias, writeSessionsIndex } from "../src/reportStore.js";
import type { CapsuleIndexEntry } from "../src/types.js";

async function main() {
  const dir = path.resolve(process.argv[2] ?? process.cwd());
  const indexPath = path.join(dir, ".mekiri", "capsule-index.jsonl");

  const raw = await fs.readFile(indexPath, "utf8");
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapsuleIndexEntry);

  const earliestBySession = new Map<string, CapsuleIndexEntry>();
  for (const entry of entries) {
    const current = earliestBySession.get(entry.sessionId);
    if (!current || entry.timestamp < current.timestamp) {
      earliestBySession.set(entry.sessionId, entry);
    }
  }

  for (const [sessionId, entry] of earliestBySession) {
    const alias = await ensureSessionAlias(dir, sessionId, entry.header, entry.timestamp);
    console.log(`${sessionId} -> ${alias}`);
  }

  await writeSessionsIndex(dir);
  console.log(`\nWrote .mekiri/sessions-index.md for ${earliestBySession.size} session(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
