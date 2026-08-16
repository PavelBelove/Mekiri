import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteType } from "./types.js";

export interface PruneAuditEntry {
  event: "prune";
  timestamp: string;
  sessionId: string;
  /** Absent for prune events produced by mekiri-proxy's wire-level rewrite --
   *  that model never creates a new session, only mekiri-host's session-fork
   *  model does. */
  newSessionId?: string;
  /** The RewriteRule.id generated for this cut by mekiri-proxy's prune()
   *  handler. Present for wire-level prunes (where newSessionId is absent) --
   *  used to synthesize a session-tree node for what never forked a real
   *  session. Absent for mekiri-host prunes, which already have newSessionId. */
  ruleId?: string;
  noteType: NoteType;
  /** Length in characters of the removed branch content — a Phase 1 proxy metric.
   *  Real token counts require live SDK usage data (see mekiri-host plan). */
  removedBranchLength: number;
  /** Length in characters of the serialized fruit — a Phase 1 proxy metric.
   *  Real token counts require live SDK usage data (see mekiri-host plan). */
  fruitLength: number;
  /** files_touched[].path entries with no matching Write/Edit/NotebookEdit
   *  tool_use found in the removed range -- see verifyFruitEvidence.ts.
   *  Absent (not empty array) when there was nothing to check, i.e. the
   *  fruit had no files_touched at all. Purely informational: prune never
   *  fails because of this. */
  unverifiedFiles?: string[];
}

export interface SproutAuditEntry {
  event: "sprout";
  timestamp: string;
  sessionId: string;
  childSessionId: string;
  /** Length in characters of the serialized sprouted branch content — Phase 1 proxy metric. */
  branchLength: number;
  /** Length in characters of the serialized harvest result — Phase 1 proxy metric. */
  harvestLength: number;
}

export interface ConfigureAuditEntry {
  event: "configure_mekiri";
  timestamp: string;
  reason: string;
  patch: unknown;
}

export interface TagAuditEntry {
  event: "tag";
  timestamp: string;
  sessionId: string;
  ruleId: string;
  /** Length in characters of the transcript slice from session start up to
   *  (and including) the quoted message -- the block being marked as
   *  important. Mirrors PruneAuditEntry.removedBranchLength's measurement
   *  convention, but nothing is removed: the marked range stays live in
   *  context, this is purely a size signal for future metrics. */
  markedLength: number;
  /** Length in characters of the serialized fruit -- a Phase 1 proxy metric,
   *  same convention as PruneAuditEntry.fruitLength. No removedBranchLength:
   *  tag never cuts anything, it's a snapshot. */
  fruitLength: number;
  /** Same evidence check as PruneAuditEntry.unverifiedFiles, run over the
   *  marked (not removed) range. */
  unverifiedFiles?: string[];
}

export interface GraftAuditEntry {
  event: "graft";
  timestamp: string;
  sessionId: string;
  /** Absent for a table-of-contents graft (no target given). */
  targetRuleId?: string;
  mode: "toc" | "full";
}

export type AuditEntry =
  | PruneAuditEntry
  | SproutAuditEntry
  | ConfigureAuditEntry
  | TagAuditEntry
  | GraftAuditEntry;

const AUDIT_RELATIVE_PATH = path.join(".mekiri", "audit.jsonl");

export async function appendAuditEntry(projectDir: string, entry: AuditEntry): Promise<void> {
  const filePath = path.join(projectDir, AUDIT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readAuditLog(projectDir: string): Promise<AuditEntry[]> {
  const filePath = path.join(projectDir, AUDIT_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}
