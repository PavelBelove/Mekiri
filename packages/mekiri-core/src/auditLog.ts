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
  noteType: NoteType;
  /** Length in characters of the removed branch content — a Phase 1 proxy metric.
   *  Real token counts require live SDK usage data (see mekiri-host plan). */
  removedBranchLength: number;
  /** Length in characters of the serialized fruit — a Phase 1 proxy metric.
   *  Real token counts require live SDK usage data (see mekiri-host plan). */
  fruitLength: number;
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

export type AuditEntry = PruneAuditEntry | SproutAuditEntry | ConfigureAuditEntry;

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
