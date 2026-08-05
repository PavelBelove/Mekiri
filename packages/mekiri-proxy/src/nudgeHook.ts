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

export interface DecideNudgeResult {
  nextState: NudgeState;
  additionalContext?: string;
  block?: { reason: string };
}

export function decideNudge(state: NudgeState | undefined, toolName: string): DecideNudgeResult {
  if (state === undefined) {
    return { nextState: { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored: 0 } };
  }

  if (isMekiriTool(toolName)) {
    return { nextState: { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored: 0 } };
  }

  const consecutiveIgnoredSoFar = state.consecutiveIgnored ?? 0;

  // Already hard-blocked: keep blocking every non-mekiri call, regardless of
  // callsSinceReset/threshold, until a real Mekiri call resets state above.
  if (consecutiveIgnoredSoFar >= HARD_BLOCK_AFTER) {
    return {
      nextState: { callsSinceReset: state.callsSinceReset, threshold: state.threshold, consecutiveIgnored: consecutiveIgnoredSoFar },
      block: { reason: blockReason(consecutiveIgnoredSoFar) },
    };
  }

  const callsSinceReset = state.callsSinceReset + 1;
  if (callsSinceReset >= state.threshold) {
    const consecutiveIgnored = consecutiveIgnoredSoFar + 1;
    const nextState = { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored };
    if (consecutiveIgnored >= HARD_BLOCK_AFTER) {
      return { nextState, block: { reason: blockReason(consecutiveIgnored) } };
    }
    return { nextState, additionalContext: nudgeText(callsSinceReset, consecutiveIgnored) };
  }

  return { nextState: { callsSinceReset, threshold: state.threshold, consecutiveIgnored: consecutiveIgnoredSoFar } };
}
