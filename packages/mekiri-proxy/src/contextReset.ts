import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readCapsule, recordDistillate } from "mekiri-core";
import { recognizePrompt } from "./promptLog.js";
import { readShadowTranscriptOrNull } from "./shadowTranscript.js";

// Mekiri's replacement for Claude Code's auto-compaction -- see
// docs/specs/2026-09-28-context-reset.md and docs/mechanics/context-reset.md.
// Near the limit the proxy drops the middle of the conversation, keeps the
// tail verbatim, and puts an instruction + the session capsule + the last
// user prompt in front of it, so the agent warms itself up from the library.
// Claude Code keeps sending its full history, so the reset is a persistent
// rule re-applied to every later request, like a prune cut.

export interface ResetRule {
  id: string;
  kind: "reset";
  /** normalizedHash of the first kept message: the tail starts there. */
  keepFromHash: string;
  /** normalizedHash of the last user prompt, when it lies before the tail --
   *  its blocks are re-injected verbatim, attachments included. */
  lastPromptHash?: string;
  /** Instruction + capsule snapshot, frozen at reset time so the injected
   *  message stays byte-identical (and cacheable) on every later request. */
  instruction: string;
  createdAt: string;
}

export interface ContextResetSettings {
  enabled: boolean;
  thresholdTokens: number;
  tailTokens: number;
  tailTurns: number;
}

interface Block {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageShape {
  role?: string;
  content?: unknown;
}

function asMessage(m: unknown): MessageShape {
  return (m ?? {}) as MessageShape;
}

function blocksOf(message: unknown): Block[] {
  const content = asMessage(message).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

export function isResetRule(rule: unknown): rule is ResetRule {
  return typeof rule === "object" && rule !== null && (rule as { kind?: unknown }).kind === "reset";
}

// ---------------------------------------------------------------------------
// Hashing and size estimate

/** Claude Code moves cache_control markers between requests; strip them so a
 *  message hashes the same wherever it sits in the history. */
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== "cache_control") out[k] = stripCacheControl(v);
    }
    return out;
  }
  return value;
}

export function normalizedHash(message: unknown): string {
  const m = asMessage(message);
  return createHash("sha256")
    .update(JSON.stringify(stripCacheControl({ role: m.role, content: m.content })))
    .digest("hex");
}

const IMAGE_TOKENS = 1600;

/** Cheap local token estimate, deliberately on the high side: ~3.2 chars per
 *  token for ASCII (code, JSON, English), ~1.6 for everything else (Cyrillic
 *  and the like). Base64 payloads and thinking signatures aren't text the
 *  model reads as tokens; an image counts as a flat IMAGE_TOKENS. */
export function estimateTokens(value: unknown): number {
  let ascii = 0;
  let other = 0;
  let fixed = 0;
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if (key === "signature" || key === "data") return;
      for (let i = 0; i < v.length; i++) {
        if (v.charCodeAt(i) < 128) ascii++;
        else other++;
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === "object" && v !== null) {
      const obj = v as Record<string, unknown>;
      if (obj.type === "image") fixed += IMAGE_TOKENS;
      if (obj.type === "base64" && typeof obj.data === "string" && obj.media_type === "application/pdf") {
        fixed += Math.ceil(obj.data.length / 4);
      }
      for (const [k, item] of Object.entries(obj)) walk(item, k);
    }
  };
  walk(value);
  return Math.ceil(ascii / 3.2 + other / 1.6) + fixed;
}

// Claude Code auto-compacts at (effective window - 13k); the override env var
// can only lower that point. "Auto" fires a margin below it, so Mekiri always
// gets there first. The window is 1M only when the request opts into it.
export function resolveThreshold(thresholdTokens: number, anthropicBeta: string | string[] | undefined): number {
  if (thresholdTokens > 0) return thresholdTokens;
  const beta = Array.isArray(anthropicBeta) ? anthropicBeta.join(",") : (anthropicBeta ?? "");
  const window = beta.includes("context-1m") ? 1_000_000 : 200_000;
  return Math.floor((window - 13_000) * 0.9);
}

// ---------------------------------------------------------------------------
// Cut selection

function isPruneToolName(name: unknown): boolean {
  return typeof name === "string" && (name === "prune" || name.endsWith("__prune"));
}

function hasToolResult(message: unknown): boolean {
  return blocksOf(message).some((b) => b.type === "tool_result");
}

/** A cut may start the tail at an assistant message (the injected user
 *  message goes in front of it) or at a user message that answers no tool
 *  call -- never between a tool_use and its tool_result. */
function isValidCut(messages: unknown[], i: number): boolean {
  if (i <= 0 || i >= messages.length) return false;
  const role = asMessage(messages[i]).role;
  return role === "assistant" || (role === "user" && !hasToolResult(messages[i]));
}

/** Index of the assistant message carrying the last prune call that already
 *  has its tool_result, or undefined. */
export function findLastPruneIndex(messages: unknown[]): number | undefined {
  for (let i = messages.length - 2; i >= 0; i--) {
    const calls = blocksOf(messages[i]).filter((b) => b.type === "tool_use" && isPruneToolName(b.name));
    if (calls.length === 0) continue;
    const ids = new Set(calls.map((c) => c.id));
    if (blocksOf(messages[i + 1]).some((b) => b.type === "tool_result" && ids.has(b.tool_use_id))) return i;
  }
  return undefined;
}

export interface CutChoice {
  cut: number;
  /** true: the tail starts at the last prune, so everything dropped is
   *  already in the library -- no [auto-reset] record needed. */
  afterLastPrune: boolean;
}

export function chooseCut(
  messages: unknown[],
  excluded: Set<number>,
  minCut: number,
  settings: Pick<ContextResetSettings, "tailTokens" | "tailTurns">,
): CutChoice | null {
  const n = messages.length;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + (excluded.has(i) ? 0 : estimateTokens(messages[i]));

  const candidates: number[] = [];
  for (let i = minCut + 1; i < n; i++) if (!excluded.has(i) && isValidCut(messages, i)) candidates.push(i);
  if (candidates.length === 0) return null;

  const lastPrune = findLastPruneIndex(messages);
  if (lastPrune !== undefined && lastPrune > minCut && !excluded.has(lastPrune) && suffix[lastPrune] <= settings.tailTokens) {
    return { cut: lastPrune, afterLastPrune: true };
  }

  // Fallback: the last K turns (a turn opens at a user message that answers
  // no tool call), shortened from the front until they fit the token cap.
  const turnStarts = candidates.filter((i) => asMessage(messages[i]).role === "user");
  const from = turnStarts.length >= settings.tailTurns ? turnStarts[turnStarts.length - settings.tailTurns] : candidates[0];
  const fitting = candidates.find((i) => i >= from && suffix[i] <= settings.tailTokens);
  // Nothing fits (one giant tool result at the tail): keep the least possible.
  return { cut: fitting ?? candidates[candidates.length - 1], afterLastPrune: false };
}

// ---------------------------------------------------------------------------
// Applying a reset rule

function findLastByHash(messages: unknown[], hash: string): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (normalizedHash(messages[i]) === hash) return i;
  return undefined;
}

/** Where the tail of the latest reset rule starts in `messages`, or 0. */
export function currentResetStart(messages: unknown[], resetRules: ResetRule[]): number {
  const latest = resetRules[resetRules.length - 1];
  if (!latest) return 0;
  return findLastByHash(messages, latest.keepFromHash) ?? 0;
}

const LAST_PROMPT_LABEL = "[Mekiri] The last user prompt before the reset, verbatim:";

/** Applies the latest reset rule on top of the prune-excluded set. The
 *  prefix outside messages[] (system, tools) is untouched; messages[0]'s
 *  system-reminder blocks (CLAUDE.md and the like) are carried over. */
export function applyReset(messages: unknown[], excluded: Set<number>, rule: ResetRule): unknown[] {
  const keep = findLastByHash(messages, rule.keepFromHash);
  if (keep === undefined || keep === 0) return messages.filter((_, i) => !excluded.has(i));

  const injected: Block[] = blocksOf(messages[0])
    .filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trimStart().startsWith("<system-reminder>"))
    .map((b) => stripCacheControl(b) as Block);
  injected.push({ type: "text", text: rule.instruction });
  if (rule.lastPromptHash) {
    const promptIdx = findLastByHash(messages, rule.lastPromptHash);
    const recognized = promptIdx !== undefined && promptIdx < keep ? recognizePrompt(asMessage(messages[promptIdx])) : null;
    if (recognized) {
      injected.push({ type: "text", text: LAST_PROMPT_LABEL });
      for (const block of recognized.blocks) injected.push(stripCacheControl(block) as Block);
    }
  }

  const tail = messages.filter((_, i) => i >= keep && !excluded.has(i));
  const first = asMessage(tail[0]);
  if (first.role === "user") {
    return [{ role: "user", content: [...injected, ...blocksOf(first)] }, ...tail.slice(1)];
  }
  return [{ role: "user", content: injected }, ...tail];
}

// ---------------------------------------------------------------------------
// Creating a reset rule

const CAPSULE_CHAR_LIMIT = 12_000;
/** Share of the messages' (estimated) tokens a reset must drop to be worth it. */
const MIN_DROP_SHARE = 0.3;

export function buildInstruction(args: {
  estimate: number;
  capsule?: string;
  recordRuleId?: string;
  hasLibrary: boolean;
  /** This session's report.md, where the dropped prune distillates live. */
  reportPath?: string;
}): string {
  const parts = [
    `[Mekiri context reset] This session reached ~${Math.round(args.estimate / 1000)}k tokens. Instead of Claude Code's auto-compaction, Mekiri dropped the middle of the conversation mechanically. Only the tail is kept verbatim (it follows this message); nothing is lost -- the earlier work is in this session's Mekiri library.`,
    `Before doing anything else, warm up with the \`mekiri-warmup\` skill (its "After a Mekiri context reset" section)${args.reportPath ? `: start with the last entries of ${args.reportPath} -- the newest kept_context notes are the current task's state` : ""}. Then continue the task the last user prompt asked for, from where the tail shows it stopped: don't redo what the capsule and tail show as finished, and don't drop what isn't finished yet.`,
  ];
  if (args.hasLibrary) {
    parts.push(
      "Earlier user prompts: graft(\"user#N\") or graft(\"user#N-M\") (see the [user #N] lines). Any capsule entry opens with graft(\"<rule_id>\").",
    );
  } else {
    parts.push("This session has no library entries yet; graft() without a target lists what the shadow archive holds.");
  }
  if (args.recordRuleId) {
    parts.push(
      `The stretch after the last prune that wasn't archived yet is the [auto-reset] entry ${args.recordRuleId}: graft("${args.recordRuleId}") returns it raw.`,
    );
  }
  if (args.capsule && args.capsule.trim() !== "") {
    let capsule = args.capsule.trimEnd();
    if (capsule.length > CAPSULE_CHAR_LIMIT) {
      capsule = "…(older lines omitted; graft() shows the full capsule)\n" + capsule.slice(capsule.length - CAPSULE_CHAR_LIMIT);
    }
    parts.push("This session's capsule.md:\n" + capsule);
  }
  return parts.join("\n\n");
}

export interface CreateResetArgs {
  sessionId: string;
  /** Project directory from rules.json; undefined before the first prune. */
  dir?: string;
  messages: unknown[];
  excluded: Set<number>;
  resetRules: ResetRule[];
  settings: ContextResetSettings;
  estimate: number;
  now?: Date;
}

export async function createResetRule(args: CreateResetArgs): Promise<ResetRule | null> {
  const { messages } = args;
  const minCut = currentResetStart(messages, args.resetRules);
  const choice = chooseCut(messages, args.excluded, minCut, args.settings);
  if (!choice) return null;
  // A reset has to free real room. When the prefix (system, tools) plus the
  // tail alone sit near the threshold, every request would otherwise reset
  // again, a message further each time, breaking the prompt cache for nothing.
  const tokensOf = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) if (!args.excluded.has(i)) sum += estimateTokens(messages[i]);
    return sum;
  };
  if (tokensOf(minCut, choice.cut) < MIN_DROP_SHARE * tokensOf(minCut, messages.length)) return null;

  const id = randomUUID();
  const timestamp = (args.now ?? new Date()).toISOString();

  let lastPromptHash: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (recognizePrompt(asMessage(messages[i]))) {
      if (i < choice.cut) lastPromptHash = normalizedHash(messages[i]);
      break;
    }
  }

  // The dropped stretch after the last prune is in neither the library nor
  // the new context: record it mechanically so graft can open it.
  let recordRuleId: string | undefined;
  const lastPrune = findLastPruneIndex(messages);
  if (args.dir && !choice.afterLastPrune && (lastPrune === undefined || choice.cut > lastPrune + 2)) {
    const shadow = await readShadowTranscriptOrNull(args.sessionId).catch(() => null);
    // The shadow archive ends with this request's last message; revision
    // lines inside the kept tail can only push the end into the tail a bit.
    const rawEndLine = shadow ? shadow.length - (messages.length - choice.cut) : 0;
    if (shadow && rawEndLine >= 1) {
      const dropped = choice.cut - (lastPrune === undefined ? 1 : lastPrune + 2);
      await recordDistillate(
        args.dir,
        {
          event: "auto-reset",
          sessionId: args.sessionId,
          ruleId: id,
          noteType: "portal",
          timestamp,
          parts: ["cut"],
          rawEndLine,
          rawSource: "shadow",
          rawTranscript: shadow,
        },
        `[auto-reset] context reset at ~${Math.round(args.estimate / 1000)}k tokens; ${dropped} unarchived messages dropped`,
        "Mechanical record written by mekiri-proxy at a context reset: the conversation after the last prune, up to the kept tail, " +
          "was dropped from the live context without a distillate. The raw messages are in the shadow archive; graft this rule_id to read them.",
      );
      recordRuleId = id;
    }
  }

  const capsule = args.dir ? await readCapsule(args.dir, args.sessionId).catch(() => "") : undefined;
  return {
    id,
    kind: "reset",
    keepFromHash: normalizedHash(messages[choice.cut]),
    ...(lastPromptHash ? { lastPromptHash } : {}),
    instruction: buildInstruction({
      estimate: args.estimate,
      capsule,
      recordRuleId,
      hasLibrary: args.dir !== undefined && capsule !== undefined && capsule.trim() !== "",
      reportPath: args.dir ? path.join(args.dir, ".mekiri", "sessions", args.sessionId, "report.md") : undefined,
    }),
    createdAt: timestamp,
  };
}
