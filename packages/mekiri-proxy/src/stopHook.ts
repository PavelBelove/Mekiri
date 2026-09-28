import type { HookState } from "./hookState.js";

const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 10;

// Deliberately duplicated from nudgeHook.ts's randomThreshold rather than
// imported: this module is loaded by bin/stop-hook.ts under plain `node
// --experimental-strip-types` (for hook-invocation latency, same as
// bin/nudge-hook.ts), which cannot resolve a runtime `import { x } from
// "./nudgeHook.js"` against the actual .ts file -- only type-only imports
// (erased before Node ever sees them) survive that constraint, as hookState.ts
// already relies on for `NudgeState`.
function randomThreshold(): number {
  return MIN_THRESHOLD + Math.floor(Math.random() * (MAX_THRESHOLD - MIN_THRESHOLD + 1));
}

export interface StopHookInput {
  lastAssistantMessage: string;
  /** Claude Code's own loop-guard signal, observed true on the Stop firing
   *  that happens as a direct result of this hook's own prior block (see
   *  .mekiri/stop-hook-spike.log). Not fully documented, but empirically
   *  present on real payloads -- trusting it here is cheap insurance against
   *  an infinite forced-continuation loop even if the harness has no
   *  independent guard of its own. */
  stopHookActive: boolean;
}

export interface StopHookConfig {
  enabled: boolean;
}

export interface DecideStopHookResult {
  nextState: HookState;
  block?: { reason: string };
}

const BLOCK_REASON =
  "[Mekiri] Ход завершён — Stop-хук принудительно продолжает сессию для гигиены контекста. " +
  "Вызови prune прямо сейчас: если в этом ходе/эпизоде было что закрыть — процитируй начало " +
  "закрываемого эпизода как обычно (или quote: \"\", если резать реально нечего). Отчёт, который " +
  "ты только что написал, и следующий промпт пользователя сохранятся автоматически -- не пытайся " +
  "резать их сам.";

// Matches decideNudge's own fresh-state shape exactly, so a nudge-hook run
// right after this one treats it as ordinary existing state (a real
// threshold, not a degenerate 0 that would trip an immediate false nudge).
function defaultNudgeState(): HookState["nudge"] {
  return { callsSinceReset: 0, threshold: randomThreshold(), consecutiveIgnored: 0, deferRemaining: 0, consecutiveTraceOnly: 0 };
}

/** Pure decision core for the Stop-hook-forced-prune mechanism -- mirrors
 *  nudgeHook.ts's decideNudge split (logic here, stdin/fs/stdout I/O in
 *  bin/stop-hook.ts) so this can be unit tested without spawning a process
 *  or touching disk. */
export function decideStopHook(
  state: HookState | undefined,
  input: StopHookInput,
  config: StopHookConfig,
): DecideStopHookResult {
  const nudge = state?.nudge ?? defaultNudgeState();

  if (!config.enabled) {
    return { nextState: { nudge, stopBoundary: state?.stopBoundary } };
  }

  if (input.stopHookActive) {
    return { nextState: { nudge, stopBoundary: state?.stopBoundary } };
  }

  const stopBoundary = { lastAssistantMessage: input.lastAssistantMessage, setAt: new Date().toISOString() };
  return {
    nextState: { nudge: { ...nudge, stopForcedPrune: true }, stopBoundary },
    block: { reason: BLOCK_REASON },
  };
}
