import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBranch } from "../src/branch.js";
import { readAuditLog } from "../src/auditLog.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile, sessionFileExists } from "./helpers/sessionFile.js";

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

  // NOTE ON DEVIATION FROM THE BRIEF: the brief's literal test code used
  // human-readable literal strings ("parent-session", and buildTranscript's
  // "user-1"/"asst-1"-style ids) as session/message identifiers. The
  // installed SDK's real `forkSession` (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs,
  // function `dF`) validates both the `sessionId` argument and `upToMessageId`
  // against a strict UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`)
  // and throws `Invalid sessionId: ...` / `Invalid upToMessageId: ...`
  // otherwise. This matches how Claude Code transcripts actually work in
  // production (session file names are always `<uuid>.jsonl`), so real
  // session/message ids passed to `createBranch` will always be UUIDs; the
  // brief's placeholder strings were just not realistic. Rather than modify
  // the shared `buildTranscript.ts` helper (owned by Task 3, used by other
  // already-passing tests), each line's `uuid`/`parentUuid` is overwritten
  // in place here, after construction, to valid UUID-shaped literals, and
  // the session id literals are UUID-shaped too. The parent/child chain and
  // all other structure/assertions are unchanged from the brief.

  const PARENT_SESSION_1 = "11111111-1111-4111-8111-111111111111";
  const PARENT_SESSION_2 = "22222222-2222-4222-8222-222222222222";

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

    const { newSessionId } = await createBranch({
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

    // forkSession appends a trailing "custom-title" metadata line to every
    // forked transcript (confirmed by direct experimentation against the
    // installed SDK; not mentioned in the brief's Background section). Check
    // the real copied content separately from that metadata line so the
    // assertion reflects verified behavior rather than silently swallowing
    // any other unexpected line.
    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines.map((line) => line.type)).toEqual(["user", "assistant"]);
    expect(forkedLines.some((line) => line.type === "custom-title")).toBe(true);

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

    const { newSessionId } = await createBranch({
      branchType: "sprout",
      sessionId: PARENT_SESSION_2,
      dir: projectDir,
      removedBranchLength: 5,
      fruitLength: 30,
      auditProjectDir: auditDir,
    });

    // See the equivalent comment in the prune test above: forkSession
    // appends a trailing "custom-title" metadata line to every fork.
    const forkedLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines).toHaveLength(2);
    expect(forkedLines.some((line) => line.type === "custom-title")).toBe(true);

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
