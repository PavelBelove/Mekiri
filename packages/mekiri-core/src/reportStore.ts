import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteType, RawLine } from "./types.js";
import type { CapsuleIndexEntry, PromptCapsuleEntry } from "./types.js";
import { summarizeToolActivity } from "./verifyFruitEvidence.js";

const CAPSULE_INDEX_RELATIVE_PATH = path.join(".mekiri", "capsule-index.jsonl");
const SESSIONS_INDEX_RELATIVE_PATH = path.join(".mekiri", "sessions-index.md");
const ALIAS_MARKER_FILENAME = ".alias";

/** Parses capsule-index.jsonl, keeping only distillate entries -- prompt
 *  bookkeeping lines (event "prompt") have no header/ruleId/ranges. */
function parseDistillateEntries(raw: string): CapsuleIndexEntry[] {
  return splitLines(raw)
    .map((line) => JSON.parse(line) as CapsuleIndexEntry | PromptCapsuleEntry)
    .filter((e): e is CapsuleIndexEntry => e.event !== "prompt");
}

function sessionsDirPath(dir: string): string {
  return path.join(dir, ".mekiri", "sessions");
}

function sessionReportPath(dir: string, sessionId: string): string {
  return path.join(dir, ".mekiri", "sessions", sessionId, "report.md");
}

function sessionCapsulePath(dir: string, sessionId: string): string {
  return path.join(dir, ".mekiri", "sessions", sessionId, "capsule.md");
}

const CYRILLIC_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** ASCII kebab-case slug for a session-alias folder name. Cyrillic (mekiri's
 *  fruit headers are typically Russian) is transliterated rather than
 *  dropped, so the alias stays recognizable instead of collapsing to "session". */
export function slugify(text: string): string {
  const translit = text
    .toLowerCase()
    .split("")
    .map((ch) => CYRILLIC_TRANSLIT[ch] ?? ch)
    .join("");
  return translit
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Creates a human-readable symlink alias (`.mekiri/sessions/<date>-<slug>`)
 *  pointing at the real `.mekiri/sessions/<sessionId>` directory, without
 *  touching sessionId-keyed addressing anywhere else. Idempotent per session
 *  via a `.alias` marker file, so repeat calls in the same session are cheap
 *  and don't create multiple symlinks. */
export async function ensureSessionAlias(dir: string, sessionId: string, header: string, timestamp: string): Promise<string> {
  const sessionsDir = sessionsDirPath(dir);
  const sessionDir = path.join(sessionsDir, sessionId);
  const markerPath = path.join(sessionDir, ALIAS_MARKER_FILENAME);

  const existing = await readFileIfExists(markerPath);
  if (existing) return existing.trim();

  await fs.mkdir(sessionDir, { recursive: true });

  const datePart = timestamp.slice(0, 10);
  const slugBase = slugify(header) || "session";

  let alias = `${datePart}-${slugBase}`;
  let suffix = 2;
  for (;;) {
    try {
      await fs.symlink(sessionId, path.join(sessionsDir, alias), "dir");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      alias = `${datePart}-${slugBase}-${suffix++}`;
    }
  }

  await fs.writeFile(markerPath, alias, "utf8");
  return alias;
}

/** Regenerates the human-readable `.mekiri/sessions-index.md`: one line per
 *  session (alias, id, time span, prune/tag counts, first header), derived
 *  from `capsule-index.jsonl`. Full rewrite each call -- cheap at the scale
 *  of tens of sessions, avoids read-modify-write bookkeeping. */
export async function writeSessionsIndex(dir: string): Promise<void> {
  const indexPath = path.join(dir, CAPSULE_INDEX_RELATIVE_PATH);
  const raw = await readFileIfExists(indexPath);
  const entries = parseDistillateEntries(raw);

  const bySession = new Map<string, CapsuleIndexEntry[]>();
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  }

  const sessionsDir = sessionsDirPath(dir);
  const rows: string[] = [];
  const sessions = [...bySession.entries()].map(([sessionId, list]) => {
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { sessionId, sorted };
  });
  sessions.sort((a, b) => a.sorted[0].timestamp.localeCompare(b.sorted[0].timestamp));

  const nl = String.fromCharCode(10);
  for (const { sessionId, sorted } of sessions) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    // entry.parts is absent on entries written before the prune+tag merge
    // (legacy "tag" events, and "prune" events from before `parts` existed) --
    // fall back to [] rather than crash on old capsule-index.jsonl data.
    const cutCount = sorted.filter((e) => (e.parts ?? []).includes("cut")).length;
    const keptCount = sorted.filter((e) => (e.parts ?? []).includes("kept")).length;
    const aliasMarker = await readFileIfExists(path.join(sessionsDir, sessionId, ALIAS_MARKER_FILENAME));
    const alias = aliasMarker.trim() || sessionId;
    const row =
      "- **" + alias + "** (" + sessionId + ") " +
      first.timestamp + " to " + last.timestamp + ", " +
      cutCount + " cut / " + keptCount + " kept " +
      String.fromCharCode(0x2014) + " " + first.header;
    rows.push(row);
  }

  const introText =
    "# Sessions" + nl + nl +
    "One line per session. Full detail lives in the session own capsule.md/report.md (open via the alias folder below)." + nl + nl;
  const content = introText + rows.join(nl) + nl;
  await fs.writeFile(path.join(dir, SESSIONS_INDEX_RELATIVE_PATH), content, "utf8");
}

export interface ReportEntryMeta {
  event: "prune" | "auto-reset";
  sessionId: string;
  ruleId: string;
  noteType: NoteType;
  timestamp: string;
  parts: ("kept" | "cut")[];
  /** 1-based index of the last raw transcript line (as returned by
   *  readSessionTranscript) covered by this entry -- the position of the
   *  cut boundary for a "cut" entry, or the transcript's current length for
   *  a kept-only entry. Undefined when the caller couldn't read the
   *  transcript (e.g. file missing); recordDistillate then skips raw-range
   *  recording for this entry entirely, rather than storing a bogus range. */
  rawEndLine?: number;
  /** See CapsuleIndexEntry.rawSource -- pass "shadow" whenever rawEndLine
   *  was sourced from the durable shadow transcript, so the chaining logic
   *  below never mixes it with a legacy, unreliable-numbering entry. */
  rawSource?: "shadow";
  /** The full shadow transcript for this session, as already read by the
   *  caller while resolving rawEndLine -- passed through so recordDistillate
   *  can slice out exactly the raw range it's about to chain
   *  (rawStartLine..rawEndLine) and compute CapsuleIndexEntry.activityLog
   *  from it mechanically, without re-reading the file itself or
   *  duplicating the chaining math on the caller's side. Only meaningful
   *  (and used) when rawEndLine is also defined. */
  rawTranscript?: RawLine[];
}

// Serializes concurrent recordDistillate calls behind an in-module
// promise-chain mutex, keyed by resolved `dir` path. Concurrent sprout/prune
// calls mean real concurrent writers are possible; without this, the
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

export interface RecordDistillateResult {
  startLine: number;
  endLine: number;
  /** Raw transcript line count actually covered by this entry's "kept" span
   *  (rawStartLine..rawEndLine) -- undefined under the same conditions
   *  CapsuleIndexEntry.rawStartLine/rawEndLine are undefined. Callers use
   *  this to judge whether kept_context/summary prose is suspiciously thin
   *  relative to how much raw transcript this entry actually covers. */
  rawSpanLength?: number;
}

export async function recordDistillate(
  dir: string,
  meta: ReportEntryMeta,
  header: string,
  bodyText: string,
): Promise<RecordDistillateResult> {
  // Keyed by project `dir` alone (not `dir`+sessionId): capsule-index.jsonl
  // stays a single project-wide file even though report.md/capsule.md are
  // now per-session, so cross-session writers (concurrent sprout calls)
  // must still serialize against each other on that shared file.
  return withDirMutex(dir, async () => {
    const indexPath = path.join(dir, CAPSULE_INDEX_RELATIVE_PATH);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });

    // Chain this session's raw-transcript range off its own previous entry
    // (rawStartLine = previous rawEndLine + 1), mirroring how startLine
    // chains off report.md's own length below. Computed up front (before
    // the report.md write) so the resulting range can also drive the
    // mechanical activityLog for this same block.
    let rawStartLine: number | undefined;
    let rawEndLine: number | undefined;
    let activityLog: string | undefined;
    if (meta.rawEndLine !== undefined) {
      const existingIndexRaw = await readFileIfExists(indexPath);
      // Only chain off prior entries recorded under the same numbering
      // scheme (rawSource === "shadow") -- a legacy entry's rawEndLine
      // points into Claude Code's own (unreliable) .jsonl line count, which
      // has no relationship to the shadow transcript's own message count.
      // Chaining onto it would silently reproduce the original bug.
      const priorRawEnds = parseDistillateEntries(existingIndexRaw)
        .filter((e) => e.sessionId === meta.sessionId && e.rawEndLine !== undefined && e.rawSource === meta.rawSource)
        .map((e) => e.rawEndLine as number);
      rawStartLine = priorRawEnds.length > 0 ? Math.max(...priorRawEnds) + 1 : 1;
      rawEndLine = meta.rawEndLine;

      if (meta.rawTranscript) {
        const clampedEndLine = Math.min(rawEndLine, meta.rawTranscript.length);
        activityLog = summarizeToolActivity(meta.rawTranscript.slice(rawStartLine - 1, clampedEndLine));
      }
    }

    const reportPath = sessionReportPath(dir, meta.sessionId);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });

    const existingRaw = await readFileIfExists(reportPath);
    const startLine = splitLines(existingRaw).length + 1;

    const metaLine = `# ${meta.event} ${meta.ruleId} session=${meta.sessionId} noteType=${meta.noteType} ${meta.timestamp}`;
    // Written whenever activityLog was computable at all (even "" -- no
    // tool_use found -- is written as its own line), so the presence of an
    // Activity line in report.md is itself a signal that this entry's range
    // was mechanically scanned, regardless of how thin the agent's own
    // kept_context/summary prose turned out to be.
    const activityLine = activityLog !== undefined ? `\nActivity: ${activityLog}` : "";
    const block = `${metaLine}\n${bodyText}${activityLine}\n`;
    await fs.appendFile(reportPath, block, "utf8");

    const blockLineCount = splitLines(block).length;
    const endLine = startLine + blockLineCount - 1;

    const capsulePath = sessionCapsulePath(dir, meta.sessionId);
    await fs.mkdir(path.dirname(capsulePath), { recursive: true });
    const partsLabel = meta.parts.length === 2 ? "kept+cut" : meta.parts[0];
    const capsuleLine =
      "«" + header + "» " + startLine + "-" + endLine + " — [" + partsLabel + "] " + meta.ruleId + "\n";
    await fs.appendFile(capsulePath, capsuleLine, "utf8");

    const indexEntry: CapsuleIndexEntry = {
      ruleId: meta.ruleId,
      header,
      startLine,
      endLine,
      event: meta.event,
      parts: meta.parts,
      sessionId: meta.sessionId,
      timestamp: meta.timestamp,
      ...(rawStartLine !== undefined ? { rawStartLine, rawEndLine, rawSource: meta.rawSource } : {}),
      ...(activityLog !== undefined ? { activityLog } : {}),
    };
    await fs.appendFile(indexPath, `${JSON.stringify(indexEntry)}\n`, "utf8");

    await ensureSessionAlias(dir, meta.sessionId, header, meta.timestamp);
    await writeSessionsIndex(dir);

    return {
      startLine,
      endLine,
      ...(rawStartLine !== undefined && rawEndLine !== undefined
        ? { rawSpanLength: rawEndLine - rawStartLine + 1 }
        : {}),
    };
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
  return parseDistillateEntries(raw).find((entry) => entry.ruleId === ruleId);
}

export interface PromptLine {
  n: number;
  /** The capsule.md line, without trailing newline -- formatted by the
   *  caller, which owns the prompt metadata. Must not contain prompt text. */
  line: string;
}

/** Appends a capsule.md line for every prompt of `sessionId` not yet
 *  recorded in capsule-index.jsonl, in `n` order, and records each as an
 *  event "prompt" index entry so it is never written twice. Returns the
 *  numbers actually written. */
export async function recordPromptLines(dir: string, sessionId: string, prompts: PromptLine[]): Promise<number[]> {
  if (prompts.length === 0) return [];
  return withDirMutex(dir, async () => {
    const indexPath = path.join(dir, CAPSULE_INDEX_RELATIVE_PATH);
    const recorded = new Set(
      splitLines(await readFileIfExists(indexPath))
        .map((line) => JSON.parse(line) as CapsuleIndexEntry | PromptCapsuleEntry)
        .filter((e): e is PromptCapsuleEntry => e.event === "prompt" && e.sessionId === sessionId)
        .map((e) => e.n),
    );
    const fresh = [...prompts].sort((a, b) => a.n - b.n).filter((p) => !recorded.has(p.n));
    if (fresh.length === 0) return [];

    const capsulePath = sessionCapsulePath(dir, sessionId);
    await fs.mkdir(path.dirname(capsulePath), { recursive: true });
    await fs.appendFile(capsulePath, fresh.map((p) => p.line + "\n").join(""), "utf8");
    const timestamp = new Date().toISOString();
    const entries = fresh.map((p): PromptCapsuleEntry => ({ event: "prompt", sessionId, n: p.n, timestamp }));
    await fs.appendFile(indexPath, entries.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
    return fresh.map((p) => p.n);
  });
}
