import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { RawLine } from "mekiri-core";
import { resolveStateDir } from "./ruleStore.js";
import { COMPACTION_SUMMARY_PREFIX, readShadowTranscriptOrNull } from "./shadowTranscript.js";

// Verbatim log of the user's own prompts, one directory per session, kept
// next to the shadow archive -- deliberately OUTSIDE any project: users
// paste API keys and personal data into prompts, and `.mekiri/` is one
// gitignore mistake away from being published. The project library only
// ever receives PromptMeta (see mcpServer's capsule `[user #N]` lines).
// Design: docs/specs/2026-09-28-prompt-log.md.

interface WireMessage {
  role: string;
  content: unknown;
}

interface WireBlock {
  type?: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string };
  [key: string]: unknown;
}

export type PromptKind = "speech" | "log" | "code" | "mixed";

export interface PromptAttachment {
  file: string;
  mediaType: string;
  bytes: number;
}

export interface PromptMeta {
  n: number;
  timestamp: string;
  messageIndex: number;
  textHash: string;
  bytes: number;
  lines: number;
  kind: PromptKind;
  gzipRatio: number;
  interrupted: boolean;
  ideOpenedFile?: string;
  attachments: PromptAttachment[];
  // Hashes of the wire blocks this prompt was made of -- dedup key for an
  // in-place edited message (interrupt), which is resent with the old
  // blocks plus new ones.
  blockHashes: string[];
  backfilled?: boolean;
}

export function promptsDir(sessionId: string): string {
  return path.join(resolveStateDir(), "prompts", sessionId);
}

function indexPath(sessionId: string): string {
  return path.join(promptsDir(sessionId), "index.jsonl");
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Recognition: a denylist over blocks of role:"user" messages. Unknown
// machine text slipping in is cheap; a real instruction slipping out is the
// failure this whole log exists to prevent.

const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;
const DROPPED_PREFIXES = [
  "<system-reminder>",
  "Stop hook feedback:",
  "Base directory for this skill:",
  // Claude Code's own auto-compaction summary, injected as a user message.
  COMPACTION_SUMMARY_PREFIX,
];
// Auto-mode classifier side requests. The daemon no longer lets them reach
// the shadow archive or this log, but archives written before that fix still
// hold them, and backfill reads those archives.
const SIDE_REQUEST_PREFIXES = ["The following is the user's CLAUDE.md configuration", "<transcript>"];
const IDE_OPENED_FILE = /opened the file (.+?) in the IDE/;

export interface RecognizedPrompt {
  blocks: WireBlock[];
  interrupted: boolean;
  ideOpenedFile?: string;
}

function toBlocks(content: unknown): WireBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((b): b is WireBlock => typeof b === "object" && b !== null);
  return [];
}

function isSideRequestMessage(message: { role?: string; content?: unknown }): boolean {
  const firstText = toBlocks(message.content).find((b) => b.type === "text")?.text?.trim() ?? "";
  return message.role === "user" && SIDE_REQUEST_PREFIXES.some((p) => firstText.startsWith(p));
}

export function recognizePrompt(message: { role?: string; content?: unknown }): RecognizedPrompt | null {
  if (message.role !== "user") return null;
  if (isSideRequestMessage(message)) return null;
  const blocks: WireBlock[] = [];
  let interrupted = false;
  let ideOpenedFile: string | undefined;
  for (const block of toBlocks(message.content)) {
    if (block.type === "text") {
      const text = (block.text ?? "").trim();
      if (text === "") continue;
      if (INTERRUPT_MARKER.test(text)) {
        interrupted = true;
        continue;
      }
      if (text.startsWith("<ide_opened_file>")) {
        ideOpenedFile = IDE_OPENED_FILE.exec(text)?.[1] ?? ideOpenedFile;
        continue;
      }
      if (DROPPED_PREFIXES.some((p) => text.startsWith(p))) continue;
      blocks.push(block);
    } else if (block.type === "image" || block.type === "document") {
      blocks.push(block);
    }
    // tool_result and anything else non-textual from the harness: dropped.
  }
  if (blocks.length === 0) return null;
  return { blocks, interrupted, ideOpenedFile };
}

// ---------------------------------------------------------------------------
// Classifier -- cheap, no model. Thresholds are first guesses, pinned by
// tests on real samples and meant to be tuned.

const LOG_LINE =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b|\[(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\]|\b(ERROR|WARN|FATAL|Traceback)\b|^\s+at .+\(|File ".+", line \d+|(?:\/[\w.@-]+){3,})/;
const CODE_LINE = /([;{}]\s*$|\)\s*$|^\s*(function|const|let|var|def|import|export|class|return|if|for|while|public|private|fn|async)\b|^\s*```)/;

export function classifyPrompt(text: string): { kind: PromptKind; gzipRatio: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  const gzipRatio = bytes >= 512 ? Math.round((bytes / gzipSync(text).length) * 100) / 100 : 1;
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const share = (re: RegExp) => (lines.length === 0 ? 0 : lines.filter((l) => re.test(l)).length / lines.length);
  const logShare = share(LOG_LINE);
  const codeShare = share(CODE_LINE);
  const letters = (text.match(/[\p{L}\s]/gu) ?? []).length;
  const letterShare = text.length === 0 ? 0 : letters / text.length;

  let kind: PromptKind = "mixed";
  if (lines.length >= 3 && logShare >= 0.5) kind = "log";
  else if (lines.length >= 3 && codeShare >= 0.5) kind = "code";
  else if (letterShare >= 0.8 && gzipRatio < 4 && logShare < 0.3 && codeShare < 0.3) kind = "speech";
  return { kind, gzipRatio };
}

// ---------------------------------------------------------------------------
// Per-session state and dedup.

interface SessionState {
  lastSeenLength?: number;
  nextN: number;
  maxLoggedIndex: number;
  loggedBlocks: Map<number, Set<string>>;
  recentTextHashes: string[];
}

const RECENT_WINDOW = 20;
const sessions = new Map<string, SessionState>();
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

export async function readPromptIndex(sessionId: string): Promise<PromptMeta[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath(sessionId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as PromptMeta);
}

function remember(state: SessionState, meta: PromptMeta): void {
  state.nextN = Math.max(state.nextN, meta.n + 1);
  state.maxLoggedIndex = Math.max(state.maxLoggedIndex, meta.messageIndex);
  const set = state.loggedBlocks.get(meta.messageIndex) ?? new Set<string>();
  for (const h of meta.blockHashes ?? []) set.add(h);
  state.loggedBlocks.set(meta.messageIndex, set);
  state.recentTextHashes.push(meta.textHash);
  if (state.recentTextHashes.length > RECENT_WINDOW) state.recentTextHashes.shift();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/**
 * Logs `message` (at wire index `messageIndex`) if it carries prompt blocks
 * not already logged. Dedup:
 * - per index: blocks already logged for this messageIndex are skipped, so an
 *   interrupt-edited message yields only the new prompt;
 * - older positions (below the newest logged index) are also checked against
 *   the last RECENT_WINDOW logged texts -- that's where a compaction shrink or
 *   a shadow-renumbered backfill would otherwise re-log a kept tail.
 */
async function logOne(
  sessionId: string,
  state: SessionState,
  message: { role?: string; content?: unknown },
  messageIndex: number,
  backfilled: boolean,
): Promise<void> {
  const recognized = recognizePrompt(message);
  if (!recognized) return;
  const already = state.loggedBlocks.get(messageIndex);
  const fresh = recognized.blocks
    .map((block) => ({ block, hash: sha256(JSON.stringify(block)) }))
    // Also drops in-message repeats: a network-drop retry has been seen
    // resending the prompt twice around the interrupt marker.
    .filter(({ hash }, i, all) => !already?.has(hash) && all.findIndex((x) => x.hash === hash) === i);
  if (fresh.length === 0) return;

  const text = fresh
    .filter(({ block }) => block.type === "text")
    .map(({ block }) => (block.text ?? "").trim())
    .join("\n\n");
  const binaries = fresh.filter(({ block }) => block.type !== "text");
  const textHash = sha256(text + "\0" + binaries.map((b) => b.hash).join(","));
  if (messageIndex < state.maxLoggedIndex && state.recentTextHashes.includes(textHash)) return;

  const n = state.nextN;
  const dir = promptsDir(sessionId);
  await ensureDir(dir);

  const attachments: PromptAttachment[] = [];
  for (const [i, { block }] of binaries.entries()) {
    const mediaType = block.source?.media_type ?? (block.type === "document" ? "text/plain" : "application/octet-stream");
    let data: Buffer;
    if (block.source?.type === "base64" && typeof block.source.data === "string") {
      data = Buffer.from(block.source.data, "base64");
    } else if (block.source?.type === "text" && typeof block.source.data === "string") {
      data = Buffer.from(block.source.data, "utf8");
    } else {
      // url/file references: keep the reference itself, there's nothing to decode.
      data = Buffer.from(JSON.stringify(block.source ?? block), "utf8");
    }
    const file = `${pad(n)}-${i + 1}.${EXTENSIONS[mediaType] ?? "bin"}`;
    await fs.writeFile(path.join(dir, file), data, { mode: 0o600 });
    attachments.push({ file, mediaType, bytes: data.length });
  }

  await fs.writeFile(path.join(dir, `${pad(n)}.md`), text, { mode: 0o600 });
  const { kind, gzipRatio } = classifyPrompt(text);
  const meta: PromptMeta = {
    n,
    timestamp: new Date().toISOString(),
    messageIndex,
    textHash,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text === "" ? 0 : text.split("\n").length,
    kind,
    gzipRatio,
    interrupted: recognized.interrupted,
    ...(recognized.ideOpenedFile ? { ideOpenedFile: recognized.ideOpenedFile } : {}),
    attachments,
    blockHashes: fresh.map((f) => f.hash),
    ...(backfilled ? { backfilled: true } : {}),
  };
  await fs.appendFile(indexPath(sessionId), JSON.stringify(meta) + "\n", { encoding: "utf8", mode: 0o600 });
  remember(state, meta);
}

async function backfillFromShadow(sessionId: string, state: SessionState): Promise<void> {
  const shadow = await readShadowTranscriptOrNull(sessionId);
  if (!shadow || shadow.length === 0) return;
  // Wire index of each shadow line: non-revision lines count up; a revision
  // line re-uses the index of the line it revises.
  const indexByUuid = new Map<string, number>();
  // Archives written before the side-request gate hold whole-thread re-copies
  // at ever-growing indices, which the per-index dedup can't see. A copy sits
  // after the same message as its original; a genuine repeat ("ok, go on")
  // follows a different reply -- so dedup on (previous message, message),
  // with an archived side request resetting "previous" like a file start.
  const seenPairs = new Set<string>();
  let previous = "";
  let next = 0;
  for (const line of shadow as RawLine[]) {
    let idx: number;
    if (line.revision === true && typeof line.revisionOf === "string" && indexByUuid.has(line.revisionOf)) {
      idx = indexByUuid.get(line.revisionOf)!;
    } else {
      idx = next++;
      if (line.uuid) indexByUuid.set(line.uuid, idx);
    }
    if (!line.message) continue;
    if (isSideRequestMessage(line.message)) {
      previous = "";
      continue;
    }
    const current = JSON.stringify(line.message);
    const pair = sha256(previous + "\0" + current);
    previous = current;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    await logOne(sessionId, state, line.message, idx, true);
  }
}

async function loadState(sessionId: string): Promise<SessionState> {
  const cached = sessions.get(sessionId);
  if (cached) return cached;
  const state: SessionState = { nextN: 1, maxLoggedIndex: -1, loggedBlocks: new Map(), recentTextHashes: [] };
  let dirExists = true;
  try {
    await fs.access(promptsDir(sessionId));
  } catch {
    dirExists = false;
  }
  if (dirExists) {
    for (const meta of await readPromptIndex(sessionId)) remember(state, meta);
  } else {
    await backfillFromShadow(sessionId, state);
  }
  sessions.set(sessionId, state);
  return state;
}

/**
 * Called on every /v1/messages request (daemon.ts), after the shadow archive
 * append. Scans only what may be new: from the previously-last message on
 * (it may have been edited in place by an interrupt), or everything after a
 * shrink or a daemon restart.
 */
export async function logNewPrompts(sessionId: string, messages: WireMessage[]): Promise<void> {
  await withSessionMutex(sessionId, async () => {
    const state = await loadState(sessionId);
    const lastSeen = state.lastSeenLength;
    const start = lastSeen === undefined || messages.length < lastSeen ? 0 : Math.max(0, lastSeen - 1);
    for (let i = start; i < messages.length; i++) {
      await logOne(sessionId, state, messages[i], i, false);
    }
    state.lastSeenLength = messages.length;
  });
}

export interface LoadedPrompt {
  meta: PromptMeta;
  text: string;
  attachments: (PromptAttachment & { path: string })[];
}

export async function readPrompt(sessionId: string, n: number): Promise<LoadedPrompt | null> {
  const meta = (await readPromptIndex(sessionId)).find((m) => m.n === n);
  if (!meta) return null;
  const dir = promptsDir(sessionId);
  const text = await fs.readFile(path.join(dir, `${pad(n)}.md`), "utf8");
  return { meta, text, attachments: meta.attachments.map((a) => ({ ...a, path: path.join(dir, a.file) })) };
}

// ---------------------------------------------------------------------------
// Rendering -- metadata only for the capsule; text only through graft.

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function describe(meta: PromptMeta): string[] {
  const parts = [formatTime(meta.timestamp), formatSize(meta.bytes)];
  if (meta.lines >= 10) parts.push(`${meta.lines.toLocaleString("ru-RU")} lines`);
  parts.push(meta.kind);
  if (meta.interrupted) parts.push("interrupted");
  if (meta.attachments.length > 0) {
    parts.push(`${meta.attachments.length} attachment${meta.attachments.length === 1 ? "" : "s"}`);
  }
  return parts;
}

/** `[user #7] 12:22 · 96 KB · 1 812 lines · log · interrupted · 2 attachments — graft("user#7")` */
export function formatPromptCapsuleLine(meta: PromptMeta): string {
  return `[user #${meta.n}] ${describe(meta).join(" · ")} — graft("user#${meta.n}")`;
}

/** `[user #7 · 12:22 · 96 KB · log · interrupted]` -- graft's per-prompt header. */
export function formatPromptHeader(meta: PromptMeta): string {
  return `[user #${meta.n} · ${describe(meta).join(" · ")}]`;
}

/** Parses `user#7`, `user#7-10`, `<sessionId>:user#7[-10]`; null if `target` isn't a prompt target. */
export function parsePromptTarget(target: string): { sessionId?: string; from: number; to: number } | null {
  const m = /^(?:([\w-]+):)?user#(\d+)(?:-(\d+))?$/.exec(target.trim());
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] !== undefined ? Number(m[3]) : from;
  if (from < 1 || to < from) return null;
  return { ...(m[1] ? { sessionId: m[1] } : {}), from, to };
}
