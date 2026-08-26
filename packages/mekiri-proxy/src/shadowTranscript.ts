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

// How many messages have already been appended to each session's shadow
// file, so a later call with the same (or a shorter, stale) `messages`
// array is a cheap no-op instead of re-reading the file to find out. Reset
// on daemon restart -- appendNewShadowMessages lazily reseeds it from disk
// the first time a given sessionId is seen again.
const archivedCounts = new Map<string, number>();

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
 * graft's dependence on that non-monotonic file).
 */
export async function appendNewShadowMessages(sessionId: string, messages: WireMessage[]): Promise<void> {
  await withSessionMutex(sessionId, async () => {
    const cached = archivedCounts.get(sessionId);
    const already = cached === undefined ? await countExistingLines(sessionId) : cached;
    if (messages.length <= already) {
      archivedCounts.set(sessionId, already);
      return;
    }
    const newOnes = messages.slice(already);
    const lines = newOnes.map((m, i) => JSON.stringify(toRawLine(m, sessionId, already + i))).join("\n") + "\n";
    const filePath = shadowTranscriptPath(sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, lines, "utf8");
    archivedCounts.set(sessionId, messages.length);
  });
}
