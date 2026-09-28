import { describe, it, expect } from "vitest";
import { decideStopHook } from "../src/stopHook.js";
import type { HookState } from "../src/hookState.js";

const NUDGE: HookState["nudge"] = {
  callsSinceReset: 0,
  threshold: 5,
  consecutiveIgnored: 0,
  deferRemaining: 0,
  consecutiveTraceOnly: 0,
};

describe("decideStopHook", () => {
  it("does not block when the kill-switch is off, and leaves state untouched", () => {
    const state: HookState = { nudge: NUDGE };
    const result = decideStopHook(state, { lastAssistantMessage: "final report", stopHookActive: false }, { enabled: false });

    expect(result.block).toBeUndefined();
    expect(result.nextState).toEqual(state);
  });

  it("does not block when stop_hook_active is true (loop guard)", () => {
    const state: HookState = { nudge: NUDGE };
    const result = decideStopHook(state, { lastAssistantMessage: "final report", stopHookActive: true }, { enabled: true });

    expect(result.block).toBeUndefined();
    expect(result.nextState).toEqual(state);
  });

  it("blocks on a normal firing, setting stopBoundary with the verbatim last assistant message", () => {
    const state: HookState = { nudge: NUDGE };
    const result = decideStopHook(state, { lastAssistantMessage: "final report", stopHookActive: false }, { enabled: true });

    expect(result.block?.reason).toContain("prune");
    expect(result.nextState.stopBoundary?.lastAssistantMessage).toBe("final report");
    expect(result.nextState.stopBoundary?.setAt).toBeTruthy();
    expect(result.nextState.nudge).toEqual({ ...NUDGE, stopForcedPrune: true });
  });

  it("overwrites an already-set stopBoundary flag with the latest message rather than stacking", () => {
    const state: HookState = {
      nudge: NUDGE,
      stopBoundary: { lastAssistantMessage: "stale report", setAt: "2026-08-25T10:00:00.000Z" },
    };
    const result = decideStopHook(state, { lastAssistantMessage: "fresh report", stopHookActive: false }, { enabled: true });

    expect(result.block).toBeDefined();
    expect(result.nextState.stopBoundary?.lastAssistantMessage).toBe("fresh report");
  });

  it("defaults nudge state when no prior state exists", () => {
    const result = decideStopHook(undefined, { lastAssistantMessage: "report", stopHookActive: false }, { enabled: true });

    expect(result.nextState.nudge.callsSinceReset).toBe(0);
    expect(result.nextState.nudge.threshold).toBeGreaterThanOrEqual(2);
    expect(result.block).toBeDefined();
  });
});
