const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 10;

function nudgeText(callsSinceReset: number): string {
  return `[Mekiri] ${callsSinceReset} шаг(ов) без prune/tag/graft/sprout. Если только что закрылся смысловой блок
(прочитан файл ради одного вопроса, прогнан один тест-сьют, получен один вердикт) —
возможно, стоит prune или tag. Если блок ещё не закрыт — просто продолжай, это не гейт.`;
}

export interface NudgeState {
  callsSinceReset: number;
  threshold: number;
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

export interface DecideNudgeResult {
  nextState: NudgeState;
  additionalContext?: string;
}

export function decideNudge(state: NudgeState | undefined, toolName: string): DecideNudgeResult {
  if (state === undefined) {
    return { nextState: { callsSinceReset: 0, threshold: randomThreshold() } };
  }

  if (isMekiriTool(toolName)) {
    return { nextState: { callsSinceReset: 0, threshold: randomThreshold() } };
  }

  const callsSinceReset = state.callsSinceReset + 1;
  if (callsSinceReset >= state.threshold) {
    return {
      nextState: { callsSinceReset: 0, threshold: randomThreshold() },
      additionalContext: nudgeText(callsSinceReset),
    };
  }

  return { nextState: { callsSinceReset, threshold: state.threshold } };
}
