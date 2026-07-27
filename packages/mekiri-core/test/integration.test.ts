import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findBoundary } from "../src/quoteMatcher.js";
import { validateFruit } from "../src/fruitSchema.js";
import { createBranch } from "../src/branch.js";
import { readAuditLog } from "../src/auditLog.js";
import { distillationRatio } from "../src/metrics.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import { writeSessionFile, readSessionFile } from "./helpers/sessionFile.js";

// forkSession requires real UUID-format sessionId/upToMessageId (verified
// during Task 7 against the SDK's compiled source) — buildTranscript.ts's
// generated ids aren't UUID-shaped, so overwrite them with literals here,
// the same way Task 7's branch.test.ts does.
const PARENT_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const U1_UUID = "33333333-3333-4333-8333-333333333333";
const A1_UUID = "44444444-4444-4444-8444-444444444444";
const A2_UUID = "55555555-5555-4555-8555-555555555555";

describe("mekiri-core end-to-end: read dirty logs, then prune(portal)", () => {
  let configDir: string;
  let projectDir: string;
  let auditDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    resetUuidCounter();
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-claude-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-integration-project-"));
    auditDir = await mkdtemp(path.join(tmpdir(), "mekiri-integration-audit-"));
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

  it("finds the boundary, validates the fruit, prunes, and reports a Distillation Ratio", async () => {
    const u1 = userLine(null, "why is CI flaky?");
    const a1 = assistantLine(u1.uuid!, "Reading the 7000 lines of CI logs to find the root cause of the flake.");
    const a2 = assistantLine(a1.uuid!, "line 6234: retry loop races with the cleanup handler.");
    u1.uuid = U1_UUID;
    a1.uuid = A1_UUID;
    a1.parentUuid = U1_UUID;
    a2.uuid = A2_UUID;
    a2.parentUuid = A1_UUID;
    const lines = [u1, a1, a2];
    await writeSessionFile(configDir, projectDir, PARENT_SESSION_ID, lines);

    const boundary = findBoundary(lines, "Reading the 7000 lines of CI logs");
    expect(boundary.status).toBe("ok");
    if (boundary.status !== "ok") return;

    const fruitCheck = validateFruit({
      noteType: "portal",
      fruit: {
        summary: "CI flake is a retry/cleanup race; fixed by locking the cleanup handler.",
        files_touched: [{ path: "ci/retry.ts", change: "added lock around cleanup" }],
      },
      keepCode: true,
    });
    expect(fruitCheck.ok).toBe(true);
    if (!fruitCheck.ok) return;

    const fruitLength = JSON.stringify(fruitCheck.fruit).length;
    // Character length of the discarded content (only a2 is discarded), matching
    // fruitLength's unit so distillationRatio computes a dimensionally coherent ratio.
    const removedBranchLength = JSON.stringify(a2).length;

    const { newSessionId } = await createBranch({
      branchType: "prune",
      sessionId: PARENT_SESSION_ID,
      dir: projectDir,
      upToMessageId: boundary.messageId,
      noteType: "portal",
      removedBranchLength,
      fruitLength,
      auditProjectDir: auditDir,
    });

    const forkedAllLines = await readSessionFile(configDir, projectDir, newSessionId);
    const forkedContentLines = forkedAllLines.filter((line) => line.type !== "custom-title");
    expect(forkedContentLines).toHaveLength(2); // u1, a1 only — a2's garbage did not survive
    expect(forkedAllLines.filter((line) => line.type === "custom-title")).toHaveLength(1);

    const log = await readAuditLog(auditDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("prune");
    if (log[0].event === "prune") {
      expect(distillationRatio(log[0])).toBeCloseTo(removedBranchLength / fruitLength, 5);
    }
  });
});
