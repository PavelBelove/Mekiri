import type { AuditEntry } from "./auditLog.js";

export interface SessionNode {
  sessionId: string;
  parentSessionId: string;
  branchType: "prune" | "sprout";
  timestamp: string;
  removedOrBranchLength: number;
  fruitOrHarvestLength: number;
}

export interface SessionTree {
  rootSessionId: string;
  nodes: SessionNode[];
}

function nodeFromEntry(entry: AuditEntry): SessionNode | undefined {
  if (entry.event === "prune") {
    // Wire-level prunes (mekiri-proxy) rewrite the request for the same
    // session and never fork a new one, so entry.newSessionId is absent.
    // With no new session there is no fork edge to add to the tree --
    // treat it the same as the other non-tree event types below.
    if (entry.newSessionId === undefined) return undefined;
    return {
      sessionId: entry.newSessionId,
      parentSessionId: entry.sessionId,
      branchType: "prune",
      timestamp: entry.timestamp,
      removedOrBranchLength: entry.removedBranchLength,
      fruitOrHarvestLength: entry.fruitLength,
    };
  }
  if (entry.event === "sprout") {
    return {
      sessionId: entry.childSessionId,
      parentSessionId: entry.sessionId,
      branchType: "sprout",
      timestamp: entry.timestamp,
      removedOrBranchLength: entry.branchLength,
      fruitOrHarvestLength: entry.harvestLength,
    };
  }
  // Other audit event types (e.g. "configure_mekiri") don't represent
  // session-tree edges; intentionally filtered out, not an unhandled case.
  return undefined;
}

/**
 * Builds the forest of session trees recorded in a project's audit.jsonl.
 * Each prune/sprout entry is an edge parentSessionId -> sessionId. A tree's
 * root is a sessionId that appears as a parent but never as a child in this
 * log (i.e. it predates the observed history or is the very first session).
 * Independent, unrelated trees (separate work sessions over the project's
 * lifetime) are the normal case, not an edge case.
 */
export function buildSessionForest(entries: AuditEntry[]): SessionTree[] {
  const allNodes: SessionNode[] = [];
  for (const entry of entries) {
    const node = nodeFromEntry(entry);
    if (node) allNodes.push(node);
  }

  const nodeIds = new Set(allNodes.map((n) => n.sessionId));
  const childrenByParent = new Map<string, SessionNode[]>();
  for (const node of allNodes) {
    if (!childrenByParent.has(node.parentSessionId)) childrenByParent.set(node.parentSessionId, []);
    childrenByParent.get(node.parentSessionId)!.push(node);
  }

  const rootIds = new Set<string>();
  for (const node of allNodes) {
    if (!nodeIds.has(node.parentSessionId)) rootIds.add(node.parentSessionId);
  }

  const forest: SessionTree[] = [];
  for (const rootSessionId of rootIds) {
    const nodes: SessionNode[] = [];
    // audit.jsonl is parsed from disk with zero validation, so a corrupted
    // or hand-edited log (or a future bug in the append path) could contain
    // a cycle. Guard against it explicitly rather than looping forever.
    const visited = new Set<string>();
    const queue = [...(childrenByParent.get(rootSessionId) ?? [])];
    while (queue.length > 0) {
      const node = queue.shift() as SessionNode;
      if (visited.has(node.sessionId)) {
        throw new Error(
          `buildSessionForest: cycle detected in audit log -- sessionId "${node.sessionId}" was reached more than once while walking the tree rooted at "${rootSessionId}"`,
        );
      }
      visited.add(node.sessionId);
      nodes.push(node);
      queue.push(...(childrenByParent.get(node.sessionId) ?? []));
    }
    forest.push({ rootSessionId, nodes });
  }
  return forest;
}

/**
 * The prune-only lineage from a tree's root to its current tip (the leaf
 * with no further prune child) -- see the design spec's VCL algorithm.
 * sprout children are never followed: a clone's content never occupied the
 * parent's context, so it isn't part of "the trunk" for this purpose.
 * A session can have at most one prune child (a pruned session is archived
 * and never pruned again), so this path is always unique.
 */
export function findPruneTrunk(tree: SessionTree): SessionNode[] {
  const pruneChildByParent = new Map<string, SessionNode>();
  for (const node of tree.nodes) {
    if (node.branchType !== "prune") continue;
    // The single-prune-child invariant should always hold (a pruned session
    // is archived and never pruned again). If the audit log violates it --
    // corruption, hand-editing, or a future append-path bug -- fail loudly
    // instead of silently keeping only the last-seen prune child.
    const existing = pruneChildByParent.get(node.parentSessionId);
    if (existing) {
      throw new Error(
        `findPruneTrunk: audit log violates single-prune-child invariant -- parent sessionId "${node.parentSessionId}" has more than one prune child ("${existing.sessionId}" and "${node.sessionId}")`,
      );
    }
    pruneChildByParent.set(node.parentSessionId, node);
  }
  const trunk: SessionNode[] = [];
  // Same trust-boundary concern as buildSessionForest: guard against a cycle
  // in the prune chain so a corrupted log can't hang this loop forever.
  const visited = new Set<string>();
  let currentId = tree.rootSessionId;
  while (pruneChildByParent.has(currentId)) {
    const next = pruneChildByParent.get(currentId) as SessionNode;
    if (visited.has(next.sessionId)) {
      throw new Error(
        `findPruneTrunk: cycle detected in prune chain -- sessionId "${next.sessionId}" was reached more than once while walking the trunk rooted at "${tree.rootSessionId}"`,
      );
    }
    visited.add(next.sessionId);
    trunk.push(next);
    currentId = next.sessionId;
  }
  return trunk;
}
