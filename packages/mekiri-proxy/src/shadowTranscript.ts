import { promises as fs } from "node:fs";
import path from "node:path";
import type { RawLine } from "mekiri-core";
import { normalizedHash } from "./messageHash.js";
import { resolveStateDir } from "./ruleStore.js";

interface WireMessage {
  role: string;
  content: unknown;
}

function shadowTranscriptPath(sessionId: string): string {
  return path.join(resolveStateDir(), "raw-transcripts", `${sessionId}.jsonl`);
}

type RawLineContent = NonNullable<RawLine["message"]>["content"];

function toRawLine(message: WireMessage, sessionId: string, index: number, revisionOf?: string): RawLine {
  return {
    type: message.role,
    uuid: `${sessionId}-${index}`,
    ...(revisionOf !== undefined ? { revision: true, revisionOf } : {}),
    message: { role: message.role, content: message.content as RawLineContent },
  };
}

// A revision line is for a real edit (an interrupt, a merged tool result),
// not for Claude Code moving cache_control or collapsing blocks to a string.
const hashMessage = normalizedHash;

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

// Independently-tracked per-session state. The two counters coincide under
// normal monotonic growth, which is why a single counter used to suffice --
// but Claude Code's native auto-compaction breaks that assumption (it
// replaces older history with one synthetic summary message, shrinking the
// wire array), and so do revision lines (below), so they're kept separate:
//
// - lastSeenLengths: length of the last `messages` array processed, used
//   only to diff the *next* call's array against (did it grow, and by how
//   much new tail).
// - fileLineCounts: actual number of lines appended to the shadow file so
//   far, used only to compute unique `uuid` offsets for newly appended
//   lines.
// - lastMessages: hash and shadow uuid of the last message archived. Claude
//   Code doesn't always grow the array: when the user interrupts the agent
//   mid-generation, the "[Request interrupted by user]" marker and the new
//   prompt are merged *into the last existing user message*, so the next
//   request has the same length and a different last message. Comparing
//   lengths alone silently dropped such prompts (seen live 2026-09-28). A
//   changed last message is appended again as a revision line (unique uuid,
//   `revision: true`, `revisionOf` pointing at the original) -- append-only
//   is preserved, so every recorded rawStartLine/rawEndLine stays valid.
//
// All reset on daemon restart -- appendNewShadowMessages lazily reseeds
// them from disk the first time a given sessionId is seen again.
const lastSeenLengths = new Map<string, number>();
const fileLineCounts = new Map<string, number>();
const lastMessages = new Map<string, { hash: string; uuid: string }>();
// Hash of messages[0] of the session's main thread. Not every request that
// carries a session's id is its main conversation: Claude Code's auto-mode
// permission classifier sends short side requests (a CLAUDE.md message plus
// a <transcript> of the conversation) under the same id. Before this gate,
// each such request looked like a compaction shrink, got archived, and the
// next main-thread request then re-archived almost the whole history after
// it (seen live 2026-09-28: shadow lines 138-162 duplicated 113-135). The
// main thread's first message is stable across requests (prompt caching
// depends on it); it only legitimately changes on auto-compaction.
const threadFirstHashes = new Map<string, string>();

export const COMPACTION_SUMMARY_PREFIX = "This session is being continued from a previous conversation";

function isCompactionStart(message: { role?: string; content?: unknown } | undefined): boolean {
  if (message?.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content.startsWith(COMPACTION_SUMMARY_PREFIX);
  return (
    Array.isArray(content) &&
    content.some(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text" &&
        String((b as { text?: unknown }).text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX),
    )
  );
}

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

async function reseedFromDisk(sessionId: string): Promise<void> {
  const raw = await readRawFile(sessionId);
  const lines = raw === null ? [] : parseTranscript(raw);
  // The current thread starts at the last compaction summary, if any.
  let threadStart = 0;
  lines.forEach((l, i) => {
    if (l.revision !== true && isCompactionStart(l.message)) threadStart = i;
  });
  lastSeenLengths.set(sessionId, lines.slice(threadStart).filter((l) => l.revision !== true).length);
  fileLineCounts.set(sessionId, lines.length);
  const first = lines[threadStart];
  if (first) threadFirstHashes.set(sessionId, hashMessage(first.message));
  else threadFirstHashes.delete(sessionId);
  const last = lines[lines.length - 1];
  if (last) {
    const originalUuid = typeof last.revisionOf === "string" ? last.revisionOf : last.uuid;
    lastMessages.set(sessionId, { hash: hashMessage(last.message), uuid: originalUuid ?? "" });
  } else {
    lastMessages.delete(sessionId);
  }
}

/**
 * Appends only what's new in `messages` beyond what's already archived
 * for this session -- called on every /v1/messages request in daemon.ts,
 * before rewriteMessages() mutates `parsed.messages` in place. Claude Code
 * resends its full accumulated wire-level history on every request
 * regardless of mekiri's own (wire-only) cuts, so this array's length grows
 * monotonically at the wire level even when Claude Code's own on-disk
 * .jsonl transcript does not (see shadowTranscript's raison d'être: fixing
 * graft's dependence on that non-monotonic file) -- with two exceptions:
 *
 * - native auto-compaction shrinks the wire array itself (it replaces older
 *   history with a single synthetic summary message). A shorter array than
 *   last seen is treated as that shrink, not as stale/duplicate input: the
 *   whole (shorter) array is archived as new rather than skipped, so real
 *   content right after a compaction doesn't silently go unarchived while
 *   waiting for the array to organically regrow past the old peak. This can
 *   duplicate a compaction's kept verbatim tail (already archived once
 *   before it shrank) -- a small duplicated stretch is strictly safer than
 *   an unbounded silent gap.
 * - an interrupt edits the last message in place (see lastMessages above);
 *   it is archived again as a revision line before any new tail.
 *
 * Side requests sharing the session id (see threadFirstHashes) are not
 * archived at all. Returns whether `messages` was accepted as the session's
 * main thread -- the prompt log only looks at requests that were.
 */
export async function appendNewShadowMessages(sessionId: string, messages: WireMessage[]): Promise<boolean> {
  return withSessionMutex(sessionId, async () => {
    if (!lastSeenLengths.has(sessionId)) await reseedFromDisk(sessionId);
    const lastSeen = lastSeenLengths.get(sessionId) ?? 0;
    if (messages.length === 0) return false;
    const firstHash = hashMessage(messages[0]);
    const trackedFirst = threadFirstHashes.get(sessionId);
    // A different first message is a new main thread only after a
    // compaction, or when it is longer than the tracked one (the tracked
    // "thread" was itself a side request seen first, e.g. after a restart
    // with no archive yet). Anything else is a side request.
    if (
      trackedFirst !== undefined &&
      firstHash !== trackedFirst &&
      !isCompactionStart(messages[0]) &&
      messages.length <= lastSeen
    ) {
      return false;
    }
    const newThread = trackedFirst !== undefined && firstHash !== trackedFirst;
    threadFirstHashes.set(sessionId, firstHash);
    let fileLines = fileLineCounts.get(sessionId) ?? 0;
    const previousLast = lastMessages.get(sessionId);

    const entries: RawLine[] = [];
    let lastUuid = previousLast?.uuid ?? "";

    if (!newThread && messages.length >= lastSeen) {
      const editedIdx = lastSeen - 1;
      if (editedIdx >= 0 && previousLast && hashMessage(messages[editedIdx]) !== previousLast.hash) {
        entries.push(toRawLine(messages[editedIdx], sessionId, fileLines + entries.length, previousLast.uuid));
      }
      for (const m of messages.slice(lastSeen)) {
        const line = toRawLine(m, sessionId, fileLines + entries.length);
        entries.push(line);
        lastUuid = line.uuid ?? "";
      }
    } else {
      for (const m of messages) {
        const line = toRawLine(m, sessionId, fileLines + entries.length);
        entries.push(line);
        lastUuid = line.uuid ?? "";
      }
    }

    lastSeenLengths.set(sessionId, messages.length);
    if (entries.length === 0) return true;

    const filePath = shadowTranscriptPath(sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    fileLines += entries.length;
    fileLineCounts.set(sessionId, fileLines);
    lastMessages.set(sessionId, { hash: hashMessage(messages[messages.length - 1]), uuid: lastUuid });
    return true;
  });
}
