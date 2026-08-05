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
    expect(nextState.consecutiveIgnored).toBe(0);
    expect(additionalContext).toBeUndefined();
  });

  it("resets the counter, threshold, and consecutiveIgnored on a mekiri tool call", () => {
    const state = { callsSinceReset: 5, threshold: 6, consecutiveIgnored: 3 };
    const { nextState, additionalContext } = decideNudge(state, "mcp__mekiri-proxy__prune");
    expect(nextState.callsSinceReset).toBe(0);
    expect(nextState.consecutiveIgnored).toBe(0);
    expect(additionalContext).toBeUndefined();
  });

  it("increments the counter on a non-mekiri tool call below threshold", () => {
    const state = { callsSinceReset: 1, threshold: 5, consecutiveIgnored: 0 };
    const { nextState, additionalContext } = decideNudge(state, "Read");
    expect(nextState.callsSinceReset).toBe(2);
    expect(nextState.threshold).toBe(5);
    expect(additionalContext).toBeUndefined();
  });

  it("fires the nudge once callsSinceReset reaches threshold, then resets callsSinceReset but bumps consecutiveIgnored", () => {
    const state = { callsSinceReset: 4, threshold: 5, consecutiveIgnored: 0 };
    const { nextState, additionalContext } = decideNudge(state, "Bash");
    expect(additionalContext).toBeDefined();
    expect(additionalContext).toContain("prune");
    expect(nextState.callsSinceReset).toBe(0);
    expect(nextState.consecutiveIgnored).toBe(1);
  });

  it("does not offer a no-op escape hatch in the first-fire message", () => {
    const state = { callsSinceReset: 4, threshold: 5, consecutiveIgnored: 0 };
    const { additionalContext } = decideNudge(state, "Bash");
    expect(additionalContext).not.toContain("это не гейт");
  });

  it("escalates the message wording as consecutiveIgnored climbs across repeated fires, then hard-blocks at the threshold", () => {
    const first = decideNudge({ callsSinceReset: 4, threshold: 5, consecutiveIgnored: 0 }, "Bash");
    expect(first.nextState.consecutiveIgnored).toBe(1);
    expect(first.additionalContext).not.toContain("подряд");

    const second = decideNudge({ ...first.nextState, callsSinceReset: 1, threshold: 2 }, "Bash");
    expect(second.nextState.consecutiveIgnored).toBe(2);
    expect(second.additionalContext).toContain("второе подряд");

    // third consecutive fire crosses HARD_BLOCK_AFTER (3): a hard block, not more escalating text
    const third = decideNudge({ ...second.nextState, callsSinceReset: 1, threshold: 2 }, "Bash");
    expect(third.nextState.consecutiveIgnored).toBe(3);
    expect(third.additionalContext).toBeUndefined();
    expect(third.block?.reason).toContain("Заблокировано");
  });

  it("returns a hard block instead of additionalContext once consecutiveIgnored reaches the threshold", () => {
    // second fire already at consecutiveIgnored=2; third fire should cross into a hard block
    const state = { callsSinceReset: 1, threshold: 2, consecutiveIgnored: 2 };
    const { nextState, additionalContext, block } = decideNudge(state, "Bash");

    expect(nextState.consecutiveIgnored).toBe(3);
    expect(block).toBeDefined();
    expect(block?.reason).toContain("Заблокировано");
    expect(additionalContext).toBeUndefined();
  });

  it("keeps blocking every subsequent non-mekiri call once hard-blocked, without waiting for the next threshold cycle", () => {
    const blockedState = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3 };

    const first = decideNudge(blockedState, "Read");
    expect(first.block).toBeDefined();
    expect(first.nextState.consecutiveIgnored).toBe(3);

    const second = decideNudge(first.nextState, "Bash");
    expect(second.block).toBeDefined();
    expect(second.nextState.consecutiveIgnored).toBe(3);
  });

  it("clears the hard block and resets state on a real mekiri tool call", () => {
    const blockedState = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 5 };
    const { nextState, block, additionalContext } = decideNudge(blockedState, "mcp__mekiri-proxy__prune");

    expect(block).toBeUndefined();
    expect(additionalContext).toBeUndefined();
    expect(nextState.consecutiveIgnored).toBe(0);
    expect(nextState.callsSinceReset).toBe(0);
  });

  it("treats a missing consecutiveIgnored on stale state as 0 rather than producing NaN/undefined wording", () => {
    const staleState = { callsSinceReset: 4, threshold: 5 } as unknown as {
      callsSinceReset: number;
      threshold: number;
      consecutiveIgnored: number;
    };
    const { nextState, additionalContext } = decideNudge(staleState, "Bash");
    expect(nextState.consecutiveIgnored).toBe(1);
    expect(additionalContext).not.toContain("undefined");
    expect(additionalContext).not.toContain("NaN");
  });
});
