import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteType } from "./types.js";
import type { CapsuleIndexEntry } from "./types.js";

const CAPSULE_INDEX_RELATIVE_PATH = path.join(".mekiri", "capsule-index.jsonl");

function sessionReportPath(dir: string, sessionId: string): string {
  return path.join(dir, ".mekiri", "sessions", sessionId, "report.md");
}

function sessionCapsulePath(dir: string, sessionId: string): string {
  return path.join(dir, ".mekiri", "sessions", sessionId, "capsule.md");
}

export interface ReportEntryMeta {
  event: "prune" | "tag";
  sessionId: string;
  ruleId: string;
  noteType: NoteType;
  timestamp: string;
}

// Serializes concurrent recordDistillate calls behind an in-module
// promise-chain mutex, keyed by resolved `dir` path. sprout.parallelism.count
// > 1 means real concurrent writers are possible; without this, the
// read-line-count-then-append step would race and both interleave appends
// and corrupt the "no gap, no overlap" line-range guarantee callers rely on.
const mutexChains = new Map<string, Promise<void>>();

async function withDirMutex<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const previous = mutexChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutexChains.set(
    key,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Splits file content into lines, dropping the trailing empty element that
 *  `String.split("\n")` produces when the content ends with a newline (which
 *  every block this module appends does). An empty/missing file has 0 lines. */
function splitLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function recordDistillate(
  dir: string,
  meta: ReportEntryMeta,
  header: string,
  bodyText: string,
): Promise<{ startLine: number; endLine: number }> {
  // Keyed by project `dir` alone (not `dir`+sessionId): capsule-index.jsonl
  // stays a single project-wide file even though report.md/capsule.md are
  // now per-session, so cross-session writers (sprout.parallelism.count > 1)
  // must still serialize against each other on that shared file.
  return withDirMutex(dir, async () => {
    const reportPath = sessionReportPath(dir, meta.sessionId);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });

    const existingRaw = await readFileIfExists(reportPath);
    const startLine = splitLines(existingRaw).length + 1;

    const metaLine = `# ${meta.event} ${meta.ruleId} session=${meta.sessionId} noteType=${meta.noteType} ${meta.timestamp}`;
    const block = `${metaLine}\n${bodyText}\n`;
    await fs.appendFile(reportPath, block, "utf8");

    const blockLineCount = splitLines(block).length;
    const endLine = startLine + blockLineCount - 1;

    const capsulePath = sessionCapsulePath(dir, meta.sessionId);
    await fs.mkdir(path.dirname(capsulePath), { recursive: true });
    const capsuleLine = `«${header}» ${startLine}-${endLine} — ${meta.event} ${meta.ruleId}\n`;
    await fs.appendFile(capsulePath, capsuleLine, "utf8");

    const indexEntry: CapsuleIndexEntry = {
      ruleId: meta.ruleId,
      header,
      startLine,
      endLine,
      event: meta.event,
      sessionId: meta.sessionId,
      timestamp: meta.timestamp,
    };
    const indexPath = path.join(dir, CAPSULE_INDEX_RELATIVE_PATH);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.appendFile(indexPath, `${JSON.stringify(indexEntry)}\n`, "utf8");

    return { startLine, endLine };
  });
}

export async function readReportRange(dir: string, sessionId: string, startLine: number, endLine: number): Promise<string> {
  const reportPath = sessionReportPath(dir, sessionId);
  const raw = await readFileIfExists(reportPath);
  const lines = splitLines(raw);
  return lines.slice(startLine - 1, endLine).join("\n");
}

/** Table of contents for one session only -- not the whole project's history.
 *  Keeps the default `graft()` toc view bounded regardless of how many past
 *  sessions have ever touched this project; browsing other sessions' entries
 *  goes through `findCapsuleEntry` (project-wide) by `ruleId` instead. */
export async function readCapsule(dir: string, sessionId: string): Promise<string> {
  const capsulePath = sessionCapsulePath(dir, sessionId);
  return readFileIfExists(capsulePath);
}

export async function findCapsuleEntry(dir: string, ruleId: string): Promise<CapsuleIndexEntry | undefined> {
  const indexPath = path.join(dir, CAPSULE_INDEX_RELATIVE_PATH);
  const raw = await readFileIfExists(indexPath);
  for (const line of splitLines(raw)) {
    const entry = JSON.parse(line) as CapsuleIndexEntry;
    if (entry.ruleId === ruleId) return entry;
  }
  return undefined;
}
