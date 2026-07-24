import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { NoteType } from "./types.js";
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

export async function createBranch(args: CreateBranchArgs): Promise<CreateBranchResult> {
  const result = await forkSession(args.sessionId, {
    dir: args.dir,
    upToMessageId: args.branchType === "prune" ? args.upToMessageId : undefined,
  });

  if (args.branchType === "prune") {
    await appendAuditEntry(args.auditProjectDir, {
      event: "prune",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      newSessionId: result.sessionId,
      noteType: args.noteType,
      removedBranchLength: args.removedBranchLength,
      fruitLength: args.fruitLength,
    });
  } else {
    await appendAuditEntry(args.auditProjectDir, {
      event: "sprout",
      timestamp: new Date().toISOString(),
      sessionId: args.sessionId,
      childSessionId: result.sessionId,
      branchLength: args.removedBranchLength,
      harvestLength: args.fruitLength,
    });
  }

  return { newSessionId: result.sessionId };
}
