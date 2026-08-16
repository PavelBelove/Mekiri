export const PACKAGE_NAME = "mekiri-core";

export type {
  SessionId,
  MessageId,
  ForkOptions,
  ForkResult,
  ExecutionBackend,
} from "./executionBackend.js";
export { createClaudeCodeBackend } from "./claudeCodeBackend.js";
export type {
  NoteType,
  BranchType,
  FileTouched,
  PortalFruit,
  DeathReloadFruit,
  Fruit,
  RawLine,
  BoundaryResult,
  CapsuleIndexEntry,
} from "./types.js";
export { validateFruit } from "./fruitSchema.js";
export type { ValidateFruitArgs, ValidateFruitResult } from "./fruitSchema.js";
export { findLastCompactBoundaryIndex } from "./compactZone.js";
export { findBoundary } from "./quoteMatcher.js";
export { resolveBoundaryWithRetry } from "./resolveBoundary.js";
export type { ResolveBoundaryOptions, ResolveBoundaryResult } from "./resolveBoundary.js";
export { MekiriConfigSchema, defaultConfig } from "./configSchema.js";
export type { MekiriConfig } from "./configSchema.js";
export { loadConfig, saveConfig, applyConfigPatch } from "./configStore.js";
export type { ConfigPatchResult } from "./configStore.js";
export { appendAuditEntry, readAuditLog } from "./auditLog.js";
export type {
  AuditEntry,
  PruneAuditEntry,
  SproutAuditEntry,
  ConfigureAuditEntry,
  TagAuditEntry,
  GraftAuditEntry,
} from "./auditLog.js";
export { recordDistillate, readReportRange, readCapsule, findCapsuleEntry, ensureSessionAlias, writeSessionsIndex, slugify } from "./reportStore.js";
export type { ReportEntryMeta } from "./reportStore.js";
export { createBranch } from "./branch.js";
export type { CreateBranchArgs, CreateBranchResult } from "./branch.js";
export { distillationRatio, branchCompression, lifetimeTokenSavings, contextRecyclingRatio, virtualContextLifetime } from "./metrics.js";
export { sanitizeDir, readSessionTranscript } from "./sessionTranscript.js";
export { findUnverifiedPaths } from "./verifyFruitEvidence.js";
export { buildSessionForest, findPruneTrunk } from "./sessionTree.js";
export type { SessionNode, SessionTree } from "./sessionTree.js";
export { computeSubsequentRequestCount, computeLifetimeTokenSavingsForTree, computeTotalContextProduced, computeVirtualContextLifetime, computeProjectReport } from "./metricsReport.js";
export type { PruneSavings, VirtualContextLifetimeResult, TreeMetricsReport, ProjectMetricsReport } from "./metricsReport.js";
