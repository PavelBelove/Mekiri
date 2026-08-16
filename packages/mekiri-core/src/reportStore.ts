import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteType } from "./types.js";
import type { CapsuleIndexEntry } from "./types.js";

const CAPSULE_INDEX_RELATIVE_PATH = path.join(".mekiri", "capsule-index.jsonl");
const SESSIONS_INDEX_RELATIVE_PATH = path.join(".mekiri", "sessions-index.md");
const ALIAS_MARKER_FILENAME = ".alias";

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
  const entries = splitLines(raw).map((line) => JSON.parse(line) as CapsuleIndexEntry);

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

  for (const { sessionId, sorted } of sessions) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pruneCount = sorted.filter((e) => e.event === "prune").length;
    const tagCount = sorted.filter((e) => e.event === "tag").length;
    const aliasMarker = await readFileIfExists(path.join(sessionsDir, sessionId, ALIAS_MARKER_FILENAME));
    const alias = aliasMarker.trim() || sessionId;
    rows.push(
      `- **${alias}** (\`${sessionId}\`) — ${first.timestamp} → ${last.timestamp}, ${pruneCount} prune / ${tagCount} tag — «${first.header}»`,
    );
  }

  const content = `# Sessions\n\nOne line per session. Full detail lives in each session's own \`capsule.md\`/\`report.md\` (open via the alias folder below).\n\n${rows.join("\n")}\n`;
  await fs.writeFile(path.join(dir, SESSIONS_INDEX_RELATIVE_PATH), content, "utf8");
}

export interface ReportEntryMeta {
  event: "prune" | "tag";
  sessionId: string;
  ruleId: string;
  noteType: NoteType;
  timestamp: string;
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

export async function recordDistillate(
  dir: string,
  meta: ReportEntryMeta,
  header: string,
  bodyText: string,
): Promise<{ startLine: number; endLine: number }> {
  // Keyed by project `dir` alone (not `dir`+sessionId): capsule-index.jsonl
  // stays a single project-wide file even though report.md/capsule.md are
  // now per-session, so cross-session writers (concurrent sprout calls)
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

    await ensureSessionAlias(dir, meta.sessionId, header, meta.timestamp);
    await writeSessionsIndex(dir);

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
