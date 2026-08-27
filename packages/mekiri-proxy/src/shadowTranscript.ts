import { promises as fs } from "node:fs";
import path from "node:path";
import type { RawLine } from "mekiri-core";
import { resolveStateDir } from "./ruleStore.js";

interface WireMessage {
  role: string;
  content: unknown;
}

function shadowTranscriptPath(sessionId: string): string {
  return path.join(resolveStateDir(), "raw-transcripts", `${sessionId}.jsonl`);
}

type RawLineContent = NonNullable<RawLine["message"]>["content"];

function toRawLine(message: WireMessage, sessionId: string, index: number): RawLine {
  return {
    type: message.role,
    uuid: `${sessionId}-${index}`,
    message: { role: message.role, content: message.content as RawLineContent },
  };
}

function parseTranscript(raw: string): RawLine[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawLine);
}

async function readRawFile(sessionId: string): Promise<string | null> {
  try {
    return await fs.readFile(shadowTranscriptPath(sessionId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Like readSessionTranscript (mekiri-core), but sourced from mekiri-proxy's
 * own durable, append-only shadow transcript instead of Claude Code's
 * mutable .jsonl file. Returns [] when the file doesn't exist.
 */
export async function readShadowTranscript(sessionId: string): Promise<RawLine[]> {
  const raw = await readRawFile(sessionId);
  return raw === null ? [] : parseTranscript(raw);
}

/**
 * Like readShadowTranscript, but distinguishes "file missing" (null) from
 * "file exists and is empty" ([]) -- graft needs this to report an honest
 * "transcript unavailable" status instead of silently treating a missing
 * file the same as an empty one.
 */
export async function readShadowTranscriptOrNull(sessionId: string): Promise<RawLine[] | null> {
  const raw = await readRawFile(sessionId);
  return raw === null ? null : parseTranscript(raw);
}

// Two independently-tracked per-session counters. They coincide under
// normal monotonic growth, which is why a single counter used to suffice --
// but Claude Code's native auto-compaction breaks that assumption (it
// replaces older history with one synthetic summary message, shrinking the
// wire array), so they're kept separate:
//
// - lastSeenLengths: length of the last `messages` array processed, used
//   only to diff the *next* call's array against (did it grow, and by how
//   much new tail).
// - fileLineCounts: actual number of lines appended to the shadow file so
//   far, used only to compute unique `uuid` offsets for newly appended
//   lines.
//
// Both reset on daemon restart -- appendNewShadowMessages lazily reseeds
// them from disk the first time a given sessionId is seen again.
const lastSeenLengths = new Map<string, number>();
const fileLineCounts = new Map<string, number>();

// Serializes concurrent appends for the same session (e.g. overlapping
// requests from a sprout child sharing the parent's proxy) so dozapisi
// never interleave and corrupt the "one RawLine per line" invariant
// readShadowTranscript relies on. Mirrors reportStore.ts's withDirMutex.
const mutexChains = new Map<string, Promise<void>>();

async function withSessionMutex<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = mutexChains.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutexChains.set(
    sessionId,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function countExistingLines(sessionId: string): Promise<number> {
  const raw = await readRawFile(sessionId);
  return raw === null ? 0 : parseTranscript(raw).length;
}

/**
 * Appends only the new tail of `messages` beyond what's already archived
 * for this session -- called on every /v1/messages request in daemon.ts,
 * before rewriteMessages() mutates `parsed.messages` in place. Claude Code
 * resends its full accumulated wire-level history on every request
 * regardless of mekiri's own (wire-only) cuts, so this array's length grows
 * monotonically at the wire level even when Claude Code's own on-disk
 * .jsonl transcript does not (see shadowTranscript's raison d'être: fixing
 * graft's dependence on that non-monotonic file) -- with one exception:
 * native auto-compaction shrinks the wire array itself (it replaces older
 * history with a single synthetic summary message). A shorter array than
 * last seen is treated as that shrink, not as stale/duplicate input: the
 * whole (shorter) array is archived as new rather than skipped, so real
 * content right after a compaction doesn't silently go unarchived while
 * waiting for the array to organically regrow past the old peak. This can
 * duplicate a compaction's kept verbatim tail (already archived once
 * before it shrank) -- a small duplicated stretch is strictly safer than
 * an unbounded silent gap.
 */
export async function appendNewShadowMessages(sessionId: string, messages: WireMessage[]): Promise<void> {
  await withSessionMutex(sessionId, async () => {
    const cachedLastSeen = lastSeenLengths.get(sessionId);
    const lastSeen = cachedLastSeen === undefined ? await countExistingLines(sessionId) : cachedLastSeen;
    if (messages.length === lastSeen) {
      lastSeenLengths.set(sessionId, lastSeen);
      return;
    }

    const newOnes = messages.length > lastSeen ? messages.slice(lastSeen) : messages;

    const cachedFileLines = fileLineCounts.get(sessionId);
    const fileLines = cachedFileLines === undefined ? await countExistingLines(sessionId) : cachedFileLines;

    const lines = newOnes.map((m, i) => JSON.stringify(toRawLine(m, sessionId, fileLines + i))).join("\n") + "\n";
    const filePath = shadowTranscriptPath(sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, lines, "utf8");

    fileLineCounts.set(sessionId, fileLines + newOnes.length);
    lastSeenLengths.set(sessionId, messages.length);
  });
}
