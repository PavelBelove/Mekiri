const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 10;
const HARD_BLOCK_AFTER = 3;

/** A soft first nudge with a built-in "just continue" escape hatch was tried
 *  and demonstrably failed: the agent read the escalating fire as advisory,
 *  judged the block "not closed yet" every time, and never once called a
 *  Mekiri tool voluntarily across a full session even after the nudge fired
 *  (see feedback_mekiri_prune_habit_gap memory, recurrence 5). The message
 *  now demands a concrete decision instead of offering a no-op default, and
 *  escalates in tone (not yet in blocking behavior) the more times in a row
 *  it fires without a real mekiri tool call resetting it. */
function nudgeText(callsSinceReset: number, consecutiveIgnored: number): string {
  const base = `[Mekiri] ${callsSinceReset} шаг(ов) без prune/tag/graft/sprout. Назови вслух: что именно только что закрылось (прочитан файл ради вопроса, прогнан тест-сьют, получен вердикт) — и prune/tag это прямо сейчас. Если правда ничего не закрылось — так и скажи явно, прежде чем продолжать.`;

  if (consecutiveIgnored <= 1) return base;
  if (consecutiveIgnored === 2) {
    return `${base}\nЭто уже второе подряд напоминание без единого вызова Mekiri-тулзы в этой сессии — предыдущее было проигнорировано молча.`;
  }
  return `${base}\nЭто уже ${consecutiveIgnored}-е подряд игнорируемое напоминание. Прежде чем звать любую другую тулзу — либо prune/tag конкретный закрытый эпизод, либо явно объясни пользователю, почему Mekiri сейчас не применим.`;
}

export interface NudgeState {
  callsSinceReset: number;
  threshold: number;
  /** Count of consecutive nudge firings with no real mekiri tool call in
   *  between. Unlike callsSinceReset/threshold, this must NOT reset when the
   *  nudge itself fires -- only a genuine `mcp__mekiri-proxy__*` call proves
   *  the agent actually acted, so only that resets it to 0. */
  consecutiveIgnored: number;
  /** Grace calls left where nudge/hard-block logic is fully suspended,
   *  granted structurally via `configure_mekiri({patch:{nudge:{deferCalls}}}})`
   *  -- see decideNudge. Unlike a text escape hatch (tried and abandoned, see
   *  comment above nudgeText), this is auditable and bounded by the config
   *  schema's max, not an unlimited self-granted pass. */
  deferRemaining: number;
}

/** Random integer in [MIN_THRESHOLD, MAX_THRESHOLD] -- a statistical stand-in
 *  for "a logical block of work just closed", which a PostToolUse hook has no
 *  way to detect precisely (it sees one tool call at a time, no cross-call
 *  semantics). Redrawn on every reset, whether the reset came from the nudge
 *  firing or from the agent using a Mekiri tool on its own. */
export function randomThreshold(): number {
  return MIN_THRESHOLD + Math.floor(Math.random() * (MAX_THRESHOLD - MIN_THRESHOLD + 1));
}

/** Matches any tool routed through the mekiri-proxy MCP server (prune, tag,
 *  graft, sprout, configure_mekiri) -- MCP tool names are qualified as
 *  `mcp__<server>__<tool>`. */
export function isMekiriTool(toolName: string): boolean {
  return toolName.includes("mekiri-proxy__");
}

/** Reason text for a hard PostToolUse block. Unlike nudgeText, this is not
 *  advisory -- it's emitted via `decision: "block"`, the strongest signal the
 *  PostToolUse hook interface offers (still feedback for Claude to act on,
 *  not a literal prevention of the tool call that already ran). */
function blockReason(consecutiveIgnored: number): string {
  return `[Mekiri] Заблокировано: ${consecutiveIgnored}-е подряд игнорируемое напоминание без единого вызова prune/tag/graft/sprout. Прежде чем продолжать — вызови подходящую Mekiri-тулзу для только что закрытого эпизода, либо явно объясни пользователю, почему Mekiri сейчас неприменим.`;
}

/** Shown instead of a block when a hard-blocked session issues a
 *  verification-shaped call (see isMutatingCall) -- these pass through so the
 *  agent can actually finish checking its own work before writing a fruit,
 *  rather than being forced to describe unverified work as done just to
 *  escape the block. State stays frozen; mutating calls are still blocked. */
function verificationAllowedText(consecutiveIgnored: number): string {
  return `[Mekiri] Хард-блок активен (${consecutiveIgnored}-е подряд игнорируемое напоминание) для мутирующих действий (Write/Edit/мутирующий Bash), но этот вызов — проверка, она пропущена. Как только проверишь результат — prune/tag эпизод, прежде чем писать или редактировать что-то новое.`;
}

const MUTATING_BASH_PATTERNS: RegExp[] = [
  /\brm\s/i,
  /\bmv\s/i,
  /\bgit\s+(commit|push|reset|checkout|clean|rm)\b/i,
  /\bnpm\s+(install|uninstall|ci)\b/i,
  />>?/,
  /\bsed\s+-i\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bkill\b/i,
];

function extractBashCommand(toolInput: unknown): string | undefined {
  if (toolInput !== null && typeof toolInput === "object" && "command" in toolInput) {
    const command = (toolInput as { command?: unknown }).command;
    return typeof command === "string" ? command : undefined;
  }
  return undefined;
}

/** Classifies a tool call as "mutating" (still blocked once hard-blocked) vs
 *  "verification-shaped" (allowed through even under a hard block). This is
 *  a habit nudge, not a security boundary, so the Bash classifier is a
 *  permissive blocklist (unmatched commands are treated as safe) rather than
 *  a strict allowlist -- false negatives here just mean the hook is a bit
 *  less strict in rare cases, which is an acceptable trade for not trapping
 *  the agent into fabricating a fruit to escape the block. A Bash call with
 *  no readable `command` (or any tool name not recognized below) falls back
 *  to `true`, conservatively, since there's nothing to classify against. */
export function isMutatingCall(toolName: string, toolInput?: unknown): boolean {
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") return false;
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") return true;
  if (toolName === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === undefined) return true;
    return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
  }
  return true;
}

export interface DecideNudgeResult {
  nextState: NudgeState;
  additionalContext?: string;
  block?: { reason: string };
}

/** @param deferCallsFromConfig `config.nudge.deferCalls` at call time, read
 *  by the caller from disk. Only takes effect when this call is itself a
 *  Mekiri tool call: it seeds `deferRemaining` on that reset, so calling
 *  `configure_mekiri({patch:{nudge:{deferCalls: N}}}})` both resets state (as
 *  any Mekiri call does) and grants N grace calls on top. The caller is
 *  expected to write `nudge.deferCalls` back to 0 in config.json right after
 *  a non-zero value is consumed here, so the grant is one-shot. */
export function decideNudge(
  state: NudgeState | undefined,
  toolName: string,
  toolInput?: unknown,
  deferCallsFromConfig = 0,
): DecideNudgeResult {
  if (state === undefined) {
    return {
      nextState: { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored: 0, deferRemaining: 0 },
    };
  }

  if (isMekiriTool(toolName)) {
    return {
      nextState: {
        callsSinceReset: 0,
        threshold: randomThreshold(),
        consecutiveIgnored: 0,
        deferRemaining: deferCallsFromConfig,
      },
    };
  }

  const consecutiveIgnoredSoFar = state.consecutiveIgnored ?? 0;
  const deferRemainingSoFar = state.deferRemaining ?? 0;

  // A structural grace period always wins over both the soft nudge and the
  // hard block: it was explicitly, auditably requested via configure_mekiri,
  // unlike the ambient "just say so" text escape hatch that never worked.
  if (deferRemainingSoFar > 0) {
    const deferRemaining = deferRemainingSoFar - 1;
    return {
      nextState: { ...state, deferRemaining },
      additionalContext:
        deferRemaining > 0
          ? `[Mekiri] Отсрочка активна: ещё ${deferRemaining} вызов(ов) до возобновления обычного счётчика.`
          : `[Mekiri] Отсрочка закончилась — следующий вызов снова считается обычным счётчиком/хард-блоком.`,
    };
  }

  // Already hard-blocked: mutating calls stay blocked; verification-shaped
  // calls (Read, safe Bash) pass through so the agent can finish checking
  // its own work before writing an honest fruit. State stays frozen either
  // way -- only a real Mekiri call or a spent defer grant clears it.
  if (consecutiveIgnoredSoFar >= HARD_BLOCK_AFTER) {
    if (isMutatingCall(toolName, toolInput)) {
      return {
        nextState: { ...state, deferRemaining: 0 },
        block: { reason: blockReason(consecutiveIgnoredSoFar) },
      };
    }
    return {
      nextState: { ...state, deferRemaining: 0 },
      additionalContext: verificationAllowedText(consecutiveIgnoredSoFar),
    };
  }

  const callsSinceReset = state.callsSinceReset + 1;
  if (callsSinceReset >= state.threshold) {
    const consecutiveIgnored = consecutiveIgnoredSoFar + 1;
    const nextState = { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored, deferRemaining: 0 };
    if (consecutiveIgnored >= HARD_BLOCK_AFTER) {
      return { nextState, block: { reason: blockReason(consecutiveIgnored) } };
    }
    return { nextState, additionalContext: nudgeText(callsSinceReset, consecutiveIgnored) };
  }

  return {
    nextState: { callsSinceReset, threshold: state.threshold, consecutiveIgnored: consecutiveIgnoredSoFar, deferRemaining: 0 },
  };
}
