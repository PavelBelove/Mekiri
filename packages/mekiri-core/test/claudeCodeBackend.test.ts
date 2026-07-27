import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeCodeBackend } from "../src/claudeCodeBackend.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile, sessionFileExists } from "./helpers/sessionFile.js";

describe("createClaudeCodeBackend", () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    resetUuidCounter();
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-backend-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-backend-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const PARENT_SESSION = "33333333-3333-4333-8333-333333333333";

  it("forkSession with upToMessageId forks up to that point (prune-shaped)", async () => {
    const u1 = userLine(null, "please fix the bug");
    const a1 = assistantLine(u1.uuid!, "reading logs now, this is the boundary sentence");
    const a2 = assistantLine(a1.uuid!, "more garbage that must not survive the prune");
    u1.uuid = "cccccccc-0000-4000-8000-000000000001";
    a1.parentUuid = u1.uuid;
    a1.uuid = "cccccccc-0000-4000-8000-000000000002";
    a2.parentUuid = a1.uuid;
    a2.uuid = "cccccccc-0000-4000-8000-000000000003";
    await writeSessionFile(configDir, projectDir, PARENT_SESSION, [u1, a1, a2]);

    const backend = createClaudeCodeBackend();
    const { newSessionId } = await backend.forkSession(PARENT_SESSION, { dir: projectDir, upToMessageId: a1.uuid });

    expect(newSessionId).not.toBe(PARENT_SESSION);
    expect(await sessionFileExists(configDir, projectDir, newSessionId)).toBe(true);

    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines.map((line) => line.type)).toEqual(["user", "assistant"]);
  });

  it("forkSession without upToMessageId forks the full current history (sprout-shaped)", async () => {
    const u1 = userLine(null, "keep working on the feature");
    const a1 = assistantLine(u1.uuid!, "understood, continuing");
    u1.uuid = "dddddddd-0000-4000-8000-000000000001";
    a1.parentUuid = u1.uuid;
    a1.uuid = "dddddddd-0000-4000-8000-000000000002";
    await writeSessionFile(configDir, projectDir, PARENT_SESSION, [u1, a1]);

    const backend = createClaudeCodeBackend();
    const { newSessionId } = await backend.forkSession(PARENT_SESSION, { dir: projectDir });

    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines).toHaveLength(2);

    const originalLines = await readSessionFile(configDir, projectDir, PARENT_SESSION);
    expect(originalLines).toHaveLength(2);
  });
});
