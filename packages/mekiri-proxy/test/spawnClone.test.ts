import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { spawnClone } from "../src/spawnClone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.mjs");

describe("spawnClone", () => {
  const marker = path.join(__dirname, "fixtures", ".fail-once-marker");

  afterEach(() => {
    if (existsSync(marker)) unlinkSync(marker);
  });

  it("spawns the clone process and parses its JSON result", async () => {
    const result = await spawnClone({
      sessionId: "parent-session",
      task: "do the thing",
      dir: "/tmp",
      proxyPort: 8791,
      depth: 1,
      claudeBin: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE],
    });
    expect(result).toEqual({ childSessionId: "child-session-456", result: "clone finished the task" });
  });

  it("retries once on the transient fork-not-found error, then succeeds", async () => {
    process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER = marker;
    const result = await spawnClone({
      sessionId: "parent-session",
      task: "do the thing",
      dir: "/tmp",
      proxyPort: 8791,
      depth: 1,
      claudeBin: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE],
    });
    expect(result.childSessionId).toBe("child-session-456");
    delete process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER;
  });
});
