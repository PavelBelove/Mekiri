import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("ruleStore", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-test-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty object when no rules file exists", async () => {
    const { loadAllRules } = await import("../src/ruleStore.js");
    expect(await loadAllRules()).toEqual({});
  });

  it("persists and reloads a rule keyed by sessionId", async () => {
    const { appendRule, loadAllRules } = await import("../src/ruleStore.js");
    const rule = { id: "rule-1", matchQuote: "some quoted text" };
    await appendRule("session-abc", "/some/project", rule);

    const all = await loadAllRules();
    expect(all["session-abc"].rules).toEqual([rule]);
    expect(all["session-abc"].dir).toBe("/some/project");
    expect(typeof all["session-abc"].updatedAt).toBe("string");
  });

  it("preserves previously saved rules for other sessions", async () => {
    const { appendRule, loadAllRules } = await import("../src/ruleStore.js");
    await appendRule("session-a", "/proj-a", { id: "rule-a", matchQuote: "some quoted text" });
    await appendRule("session-b", "/proj-b", { id: "rule-b", matchQuote: "other quoted text" });

    const all = await loadAllRules();
    expect(Object.keys(all).sort()).toEqual(["session-a", "session-b"]);
  });

  it("accumulates rules for the same session across multiple appendRule calls", async () => {
    const { appendRule, loadAllRules } = await import("../src/ruleStore.js");
    const ruleOne = { id: "rule-1", matchQuote: "first quote" };
    const ruleTwo = { id: "rule-2", matchQuote: "second quote" };
    await appendRule("session-abc", "/some/project", ruleOne);
    await appendRule("session-abc", "/some/project", ruleTwo);

    const all = await loadAllRules();
    expect(all["session-abc"].rules).toEqual([ruleOne, ruleTwo]);
  });

  it("does not crash on an old-format entry keyed by .rule instead of .rules", async () => {
    const rulesFile = path.join(stateDir, "rules.json");
    writeFileSync(
      rulesFile,
      JSON.stringify({
        "old-session": { dir: "/old/project", rule: { matchQuote: "x", replacement: [] }, updatedAt: "2026-01-01T00:00:00.000Z" },
      }),
      "utf8"
    );

    const { loadAllRules } = await import("../src/ruleStore.js");
    const all = await loadAllRules();
    expect(all["old-session"].rules).toEqual([]);
    expect(all["old-session"].dir).toBe("/old/project");
  });
});
