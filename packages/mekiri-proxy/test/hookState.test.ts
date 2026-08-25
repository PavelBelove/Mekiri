import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHookState, saveHookState } from "../src/hookState.js";
import type { NudgeState } from "../src/nudgeHook.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "mekiri-hookstate-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const SAMPLE_NUDGE: NudgeState = {
  callsSinceReset: 1,
  threshold: 5,
  consecutiveIgnored: 0,
  deferRemaining: 0,
  consecutiveTraceOnly: 0,
};

describe("loadHookState", () => {
  it("returns undefined when no state file exists yet", async () => {
    const state = await loadHookState(projectDir, "session-1");
    expect(state).toBeUndefined();
  });

  it("returns undefined (not a throw) for a malformed state file", async () => {
    const filePath = path.join(projectDir, ".mekiri", "hook-state", "session-1.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not json", "utf8");
    const state = await loadHookState(projectDir, "session-1");
    expect(state).toBeUndefined();
  });
});

describe("saveHookState / loadHookState roundtrip", () => {
  it("persists and reloads nudge state alone", async () => {
    await saveHookState(projectDir, "session-1", { nudge: SAMPLE_NUDGE });
    const state = await loadHookState(projectDir, "session-1");
    expect(state).toEqual({ nudge: SAMPLE_NUDGE });
  });

  it("persists and reloads a stopBoundary flag alongside nudge state", async () => {
    const stopBoundary = { lastAssistantMessage: "here is my report", setAt: "2026-08-25T12:00:00.000Z" };
    await saveHookState(projectDir, "session-1", { nudge: SAMPLE_NUDGE, stopBoundary });
    const state = await loadHookState(projectDir, "session-1");
    expect(state).toEqual({ nudge: SAMPLE_NUDGE, stopBoundary });
  });

  it("keeps sessions independent -- writing one session's state does not affect another's", async () => {
    await saveHookState(projectDir, "session-1", { nudge: SAMPLE_NUDGE });
    await saveHookState(projectDir, "session-2", { nudge: { ...SAMPLE_NUDGE, callsSinceReset: 9 } });
    const state1 = await loadHookState(projectDir, "session-1");
    const state2 = await loadHookState(projectDir, "session-2");
    expect(state1?.nudge.callsSinceReset).toBe(1);
    expect(state2?.nudge.callsSinceReset).toBe(9);
  });

  it("overwrites the previous state entirely on save, so dropping stopBoundary from the object clears it on disk", async () => {
    await saveHookState(projectDir, "session-1", {
      nudge: SAMPLE_NUDGE,
      stopBoundary: { lastAssistantMessage: "report", setAt: "2026-08-25T12:00:00.000Z" },
    });
    await saveHookState(projectDir, "session-1", { nudge: SAMPLE_NUDGE });
    const state = await loadHookState(projectDir, "session-1");
    expect(state?.stopBoundary).toBeUndefined();
  });
});
