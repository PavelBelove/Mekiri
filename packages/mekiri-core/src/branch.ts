import type { NoteType } from "./types.js";
import type { ExecutionBackend } from "./executionBackend.js";
import { appendAuditEntry } from "./auditLog.js";

interface CreateBranchCommon {
  sessionId: string;
  dir: string;
  removedBranchLength: number;
  fruitLength: number;
  auditProjectDir: string;
}

export type CreateBranchArgs =
  | (CreateBranchCommon & { branchType: "prune"; upToMessageId: string; noteType: NoteType })
  | (CreateBranchCommon & { branchType: "sprout" });

export interface CreateBranchResult {
  newSessionId: string;
}

export async function createBranch(backend: ExecutionBackend, args: CreateBranchArgs): Promise<CreateBranchResult> {
  const result = await backend.forkSession(args.sessionId, {
    dir: args.dir,
    upToMessageId: args.branchType === "prune" ? args.upToMessageId : undefined,
  });

  if (args.branchType === "prune") {
    await appendAuditEntry(args.auditProjectDir, {
      event: "prune",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      newSessionId: result.newSessionId,
      noteType: args.noteType,
      removedBranchLength: args.removedBranchLength,
      fruitLength: args.fruitLength,
    });
  } else {
    await appendAuditEntry(args.auditProjectDir, {
      event: "sprout",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      childSessionId: result.newSessionId,
      branchLength: args.removedBranchLength,
      harvestLength: args.fruitLength,
    });
  }

  return { newSessionId: result.newSessionId };
}
