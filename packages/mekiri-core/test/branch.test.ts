import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBranch } from "../src/branch.js";
import type { ExecutionBackend, ForkOptions, ForkResult } from "../src/executionBackend.js";
import { readAuditLog } from "../src/auditLog.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile, sessionFileExists } from "./helpers/sessionFile.js";
import type { RawLine } from "../src/types.js";

describe("createBranch", () => {
  let configDir: string;
  let projectDir: string;
  let auditDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    resetUuidCounter();
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-claude-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-project-"));
    auditDir = await mkdtemp(path.join(tmpdir(), "mekiri-branch-audit-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(auditDir, { recursive: true, force: true });
  });

  const PARENT_SESSION_1 = "11111111-1111-4111-8111-111111111111";
  const PARENT_SESSION_2 = "22222222-2222-4222-8222-222222222222";

  function fakeBackend(newSessionId: string, sourceLines: RawLine[]): ExecutionBackend {
    return {
      async forkSession(_sessionId: string, options: ForkOptions): Promise<ForkResult> {
        // Mirror the real ClaudeCodeBackend's on-disk effect (a forked
        // session file must exist for readSessionFile/sessionFileExists to
        // find it) without making a real SDK call -- createBranch's own
        // logic under test here is the audit-entry writing and prune/sprout
        // branching, not forking itself (that's claudeCodeBackend.test.ts's
        // job).
        const linesToCopy = options.upToMessageId
          ? sourceLines.slice(0, sourceLines.findIndex((l) => l.uuid === options.upToMessageId) + 1)
          : sourceLines;
        await writeSessionFile(configDir, projectDir, newSessionId, linesToCopy);
        return { newSessionId };
      },
    };
  }

  it("prunes a branch: forks up to the boundary, drops later messages, records an audit entry", async () => {
    const u1 = userLine(null, "please fix the bug");
    const a1 = assistantLine(u1.uuid!, "reading logs now, this is the boundary sentence");
    const a2 = assistantLine(a1.uuid!, "more garbage that must not survive the prune");
    u1.uuid = "aaaaaaaa-0000-4000-8000-000000000001";
    a1.parentUuid = u1.uuid;
    a1.uuid = "aaaaaaaa-0000-4000-8000-000000000002";
    a2.parentUuid = a1.uuid;
    a2.uuid = "aaaaaaaa-0000-4000-8000-000000000003";
    await writeSessionFile(configDir, projectDir, PARENT_SESSION_1, [u1, a1, a2]);

    const backend = fakeBackend("eeeeeeee-0000-4000-8000-000000000001", [u1, a1, a2]);
    const { newSessionId } = await createBranch(backend, {
      branchType: "prune",
      sessionId: PARENT_SESSION_1,
      dir: projectDir,
      upToMessageId: a1.uuid!,
      noteType: "portal",
      removedBranchLength: 1,
      fruitLength: 42,
      auditProjectDir: auditDir,
    });

    expect(newSessionId).not.toBe(PARENT_SESSION_1);
    expect(await sessionFileExists(configDir, projectDir, newSessionId)).toBe(true);

    // custom-title-line behavior is the real SDK's own side effect, proven
    // separately (and still) by claudeCodeBackend.test.ts (Task 2). This
    // fake backend only needs to prove createBranch's own orchestration --
    // that the right content landed in the right file.
    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    expect(forkedLines.map((line) => line.type)).toEqual(["user", "assistant"]);

    const originalLines = await readSessionFile(configDir, projectDir, PARENT_SESSION_1);
    expect(originalLines).toHaveLength(3);

    const log = await readAuditLog(auditDir);
    expect(log).toEqual([
      {
        event: "prune",
        timestamp: log[0].timestamp,
        sessionId: PARENT_SESSION_1,
        newSessionId,
        noteType: "portal",
        removedBranchLength: 1,
        fruitLength: 42,
      },
    ]);
  });

  it("sprouts a branch: full copy, parent untouched, records a sprout audit entry", async () => {
    const u1 = userLine(null, "keep working on the feature");
    const a1 = assistantLine(u1.uuid!, "understood, continuing");
    u1.uuid = "bbbbbbbb-0000-4000-8000-000000000001";
    a1.parentUuid = u1.uuid;
    a1.uuid = "bbbbbbbb-0000-4000-8000-000000000002";
    await writeSessionFile(configDir, projectDir, PARENT_SESSION_2, [u1, a1]);

    const backend = fakeBackend("eeeeeeee-0000-4000-8000-000000000002", [u1, a1]);
    const { newSessionId } = await createBranch(backend, {
      branchType: "sprout",
      sessionId: PARENT_SESSION_2,
      dir: projectDir,
      removedBranchLength: 5,
      fruitLength: 30,
      auditProjectDir: auditDir,
    });

    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    expect(forkedLines).toHaveLength(2);

    const originalLines = await readSessionFile(configDir, projectDir, PARENT_SESSION_2);
    expect(originalLines).toHaveLength(2);

    const log = await readAuditLog(auditDir);
    expect(log).toEqual([
      {
        event: "sprout",
        timestamp: log[0].timestamp,
        sessionId: PARENT_SESSION_2,
        childSessionId: newSessionId,
        branchLength: 5,
        harvestLength: 30,
      },
    ]);
  });
});
