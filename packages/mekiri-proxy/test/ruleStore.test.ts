import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    const { saveRule, loadAllRules } = await import("../src/ruleStore.js");
    const rule = { matchQuote: "some quoted text", replacement: [{ role: "user" as const, content: "note" }] };
    await saveRule("session-abc", "/some/project", rule);

    const all = await loadAllRules();
    expect(all["session-abc"].rule).toEqual(rule);
    expect(all["session-abc"].dir).toBe("/some/project");
    expect(typeof all["session-abc"].updatedAt).toBe("string");
  });

  it("preserves previously saved rules for other sessions", async () => {
    const { saveRule, loadAllRules } = await import("../src/ruleStore.js");
    await saveRule("session-a", "/proj-a", { matchQuote: "some quoted text", replacement: [] });
    await saveRule("session-b", "/proj-b", { matchQuote: "other quoted text", replacement: [] });

    const all = await loadAllRules();
    expect(Object.keys(all).sort()).toEqual(["session-a", "session-b"]);
  });
});
