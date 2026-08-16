import { describe, it, expect } from "vitest";
import { decideNudge, isMekiriTool, isMutatingCall, randomThreshold } from "../src/nudgeHook.js";

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

  it("keeps blocking every subsequent mutating non-mekiri call once hard-blocked, without waiting for the next threshold cycle", () => {
    const blockedState = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3 };

    const first = decideNudge(blockedState, "Write");
    expect(first.block).toBeDefined();
    expect(first.nextState.consecutiveIgnored).toBe(3);

    const second = decideNudge(first.nextState, "Bash", { command: "rm -rf tmp" });
    expect(second.block).toBeDefined();
    expect(second.nextState.consecutiveIgnored).toBe(3);
  });

  it("lets a verification-shaped call through under a hard block instead of blocking it", () => {
    const blockedState = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3 };

    const readCall = decideNudge(blockedState, "Read");
    expect(readCall.block).toBeUndefined();
    expect(readCall.additionalContext).toContain("Хард-блок активен");
    expect(readCall.nextState.consecutiveIgnored).toBe(3);

    const safeBash = decideNudge(blockedState, "Bash", { command: "npm test" });
    expect(safeBash.block).toBeUndefined();
    expect(safeBash.additionalContext).toContain("Хард-блок активен");
  });

  it("still blocks a Bash call under hard block when tool_input has no readable command", () => {
    const blockedState = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3 };
    const { block } = decideNudge(blockedState, "Bash", {});
    expect(block).toBeDefined();
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

  describe("deferCalls grace period", () => {
    it("seeds deferRemaining from deferCallsFromConfig only on a mekiri tool call", () => {
      const state = { callsSinceReset: 5, threshold: 6, consecutiveIgnored: 3, deferRemaining: 0 };
      const { nextState } = decideNudge(state, "mcp__mekiri-proxy__configure_mekiri", undefined, 4);
      expect(nextState.deferRemaining).toBe(4);
      expect(nextState.consecutiveIgnored).toBe(0);
    });

    it("suspends counting and blocking while deferRemaining is positive, decrementing each call", () => {
      const state = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3, deferRemaining: 2 };

      const first = decideNudge(state, "Write");
      expect(first.block).toBeUndefined();
      expect(first.nextState.deferRemaining).toBe(1);
      expect(first.nextState.consecutiveIgnored).toBe(3); // frozen, not cleared

      const second = decideNudge(first.nextState, "Write");
      expect(second.block).toBeUndefined();
      expect(second.nextState.deferRemaining).toBe(0);
    });

    it("resumes normal hard-block behavior once deferRemaining reaches 0", () => {
      const state = { callsSinceReset: 0, threshold: 7, consecutiveIgnored: 3, deferRemaining: 1 };
      const spent = decideNudge(state, "Write");
      expect(spent.nextState.deferRemaining).toBe(0);

      const { block } = decideNudge(spent.nextState, "Write");
      expect(block).toBeDefined();
    });
  });
});

describe("isMutatingCall", () => {
  it("treats Read/Grep/Glob as non-mutating", () => {
    expect(isMutatingCall("Read")).toBe(false);
    expect(isMutatingCall("Grep")).toBe(false);
    expect(isMutatingCall("Glob")).toBe(false);
  });

  it("treats Write/Edit/NotebookEdit as mutating", () => {
    expect(isMutatingCall("Write")).toBe(true);
    expect(isMutatingCall("Edit")).toBe(true);
    expect(isMutatingCall("NotebookEdit")).toBe(true);
  });

  it("classifies common verification Bash commands as non-mutating", () => {
    expect(isMutatingCall("Bash", { command: "npm test" })).toBe(false);
    expect(isMutatingCall("Bash", { command: "npm run build" })).toBe(false);
    expect(isMutatingCall("Bash", { command: "ls -la .mekiri/sessions/" })).toBe(false);
    expect(isMutatingCall("Bash", { command: "cat file.md" })).toBe(false);
    expect(isMutatingCall("Bash", { command: "git status --short" })).toBe(false);
  });

  it("classifies known mutating Bash commands as mutating regardless of surrounding text", () => {
    expect(isMutatingCall("Bash", { command: "rm -rf node_modules" })).toBe(true);
    expect(isMutatingCall("Bash", { command: "git commit -m 'x'" })).toBe(true);
    expect(isMutatingCall("Bash", { command: "npm install left-pad" })).toBe(true);
    expect(isMutatingCall("Bash", { command: "echo hi > out.txt" })).toBe(true);
  });

  it("falls back to true (conservative) for Bash with no readable command", () => {
    expect(isMutatingCall("Bash", {})).toBe(true);
    expect(isMutatingCall("Bash", undefined)).toBe(true);
  });

  it("falls back to true for an unrecognized tool name", () => {
    expect(isMutatingCall("SomeFutureTool")).toBe(true);
  });
});
