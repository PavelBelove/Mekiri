import { describe, it, expect } from "vitest";
import { decideNudge, isMekiriTool, randomThreshold } from "../src/nudgeHook.js";

describe("isMekiriTool", () => {
  it("matches MCP-qualified mekiri-proxy tool names", () => {
    expect(isMekiriTool("mcp__mekiri-proxy__prune")).toBe(true);
    expect(isMekiriTool("mcp__mekiri-proxy__tag")).toBe(true);
    expect(isMekiriTool("mcp__mekiri-proxy__sprout")).toBe(true);
  });

  it("does not match unrelated tools", () => {
    expect(isMekiriTool("Read")).toBe(false);
    expect(isMekiriTool("Bash")).toBe(false);
    expect(isMekiriTool("mcp__other-server__thing")).toBe(false);
  });
});

describe("randomThreshold", () => {
  it("always returns an integer in [2, 10]", () => {
    for (let i = 0; i < 1000; i++) {
      const t = randomThreshold();
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(2);
      expect(t).toBeLessThanOrEqual(10);
    }
  });

  it("produces more than one distinct value across many draws", () => {
    const values = new Set(Array.from({ length: 200 }, () => randomThreshold()));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("decideNudge", () => {
  it("initializes fresh state on first call without firing", () => {
    const { nextState, additionalContext } = decideNudge(undefined, "Read");
    expect(nextState.callsSinceReset).toBe(0);
    expect(nextState.threshold).toBeGreaterThanOrEqual(2);
    expect(nextState.threshold).toBeLessThanOrEqual(10);
    expect(additionalContext).toBeUndefined();
  });

  it("resets the counter and redraws threshold on a mekiri tool call", () => {
    const state = { callsSinceReset: 5, threshold: 6 };
    const { nextState, additionalContext } = decideNudge(state, "mcp__mekiri-proxy__prune");
    expect(nextState.callsSinceReset).toBe(0);
    expect(additionalContext).toBeUndefined();
  });

  it("increments the counter on a non-mekiri tool call below threshold", () => {
    const state = { callsSinceReset: 1, threshold: 5 };
    const { nextState, additionalContext } = decideNudge(state, "Read");
    expect(nextState.callsSinceReset).toBe(2);
    expect(nextState.threshold).toBe(5);
    expect(additionalContext).toBeUndefined();
  });

  it("fires the nudge once callsSinceReset reaches threshold, then resets", () => {
    const state = { callsSinceReset: 4, threshold: 5 };
    const { nextState, additionalContext } = decideNudge(state, "Bash");
    expect(additionalContext).toBeDefined();
    expect(additionalContext).toContain("prune");
    expect(nextState.callsSinceReset).toBe(0);
  });
});
