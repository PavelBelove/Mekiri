import { promises as fs } from "node:fs";
import path from "node:path";
import type { NudgeState } from "./nudgeHook.js";

/** Per-session hook state persisted at `.mekiri/hook-state/<session_id>.json`.
 *  Historically this file held a raw NudgeState directly; it's now wrapped so
 *  the Stop-hook-forced-prune mechanism (stopBoundary) can share the same
 *  file/lifecycle without a second fs round-trip per turn. Every consumer
 *  (bin/nudge-hook.ts, bin/stop-hook.ts, mcpServer.ts's prune handler) must
 *  go through loadHookState/saveHookState so the shape never drifts. */
export interface HookState {
  nudge: NudgeState;
  /** Set by bin/stop-hook.ts when it force-blocks a Stop event: the report
   *  the agent just finished, verbatim, so the next prune call can pull its
   *  cut-range end back to just before this message instead of the tool_use
   *  anchor (see rewriteMessages.ts's preserveFromQuote). Consumed and
   *  cleared by mcpServer.ts's prune handler once it acts on it -- one-shot,
   *  same pattern as nudge.deferCalls. */
  stopBoundary?: { lastAssistantMessage: string; setAt: string };
}

function hookStatePath(dir: string, sessionId: string): string {
  return path.join(dir, ".mekiri", "hook-state", `${sessionId}.json`);
}

export async function loadHookState(dir: string, sessionId: string): Promise<HookState | undefined> {
  try {
    const raw = await fs.readFile(hookStatePath(dir, sessionId), "utf8");
    return JSON.parse(raw) as HookState;
  } catch {
    return undefined;
  }
}

export async function saveHookState(dir: string, sessionId: string, state: HookState): Promise<void> {
  const filePath = hookStatePath(dir, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state), "utf8");
}
