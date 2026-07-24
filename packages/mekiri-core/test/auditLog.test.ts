import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAuditEntry, readAuditLog, type AuditEntry } from "../src/auditLog.js";

describe("audit log", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-audit-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns an empty array when no log file exists", async () => {
    expect(await readAuditLog(projectDir)).toEqual([]);
  });

  it("appends and reads back entries in order", async () => {
    const first: AuditEntry = {
      event: "prune",
      timestamp: "2026-07-24T00:00:00.000Z",
      sessionId: "parent-1",
      newSessionId: "child-1",
      noteType: "portal",
      removedBranchLength: 4,
      fruitLength: 42,
    };
    const second: AuditEntry = {
      event: "sprout",
      timestamp: "2026-07-24T00:01:00.000Z",
      sessionId: "parent-1",
      childSessionId: "child-2",
      branchLength: 10,
      harvestLength: 20,
    };
    await appendAuditEntry(projectDir, first);
    await appendAuditEntry(projectDir, second);

    const log = await readAuditLog(projectDir);
    expect(log).toEqual([first, second]);
  });
});
