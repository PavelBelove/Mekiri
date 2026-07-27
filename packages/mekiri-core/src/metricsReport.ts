import type { PruneAuditEntry } from "./auditLog.js";
import { lifetimeTokenSavings } from "./metrics.js";
import { readSessionTranscript } from "./sessionTranscript.js";
import type { SessionTree, SessionNode } from "./sessionTree.js";

async function countUserTurns(dir: string, sessionId: string): Promise<number> {
  const lines = await readSessionTranscript(dir, sessionId);
  return lines.filter((line) => line.type === "user").length;
}

function subtreeSessionIds(tree: SessionTree, fromSessionId: string): string[] {
  const childrenByParent = new Map<string, SessionNode[]>();
  for (const node of tree.nodes) {
    if (!childrenByParent.has(node.parentSessionId)) childrenByParent.set(node.parentSessionId, []);
    childrenByParent.get(node.parentSessionId)!.push(node);
  }
  const ids: string[] = [fromSessionId];
  const queue = [...(childrenByParent.get(fromSessionId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift() as SessionNode;
    ids.push(node.sessionId);
    queue.push(...(childrenByParent.get(node.sessionId) ?? []));
  }
  return ids;
}

/**
 * Counts real user turns across fromSessionId and its whole subtree
 * (both prune-continuations and sprout-offshoots -- a clone forked after
 * the prune being analyzed still would have needed to re-transmit the
 * removed content had it not been pruned, so its turns count too).
 */
export async function computeSubsequentRequestCount(dir: string, tree: SessionTree, fromSessionId: string): Promise<number> {
  const ids = subtreeSessionIds(tree, fromSessionId);
  const counts = await Promise.all(ids.map((id) => countUserTurns(dir, id)));
  return counts.reduce((sum, c) => sum + c, 0);
}

export interface PruneSavings {
  sessionId: string;
  newSessionId: string;
  subsequentRequestCount: number;
  savings: number;
}

export async function computeLifetimeTokenSavingsForTree(dir: string, tree: SessionTree, entries: PruneAuditEntry[]): Promise<PruneSavings[]> {
  const results: PruneSavings[] = [];
  for (const entry of entries) {
    const subsequentRequestCount = await computeSubsequentRequestCount(dir, tree, entry.newSessionId);
    results.push({
      sessionId: entry.sessionId,
      newSessionId: entry.newSessionId,
      subsequentRequestCount,
      savings: lifetimeTokenSavings(entry, subsequentRequestCount),
    });
  }
  return results;
}

export async function computeTotalContextProduced(dir: string, tree: SessionTree): Promise<number> {
  const allIds = [tree.rootSessionId, ...tree.nodes.map((n) => n.sessionId)];
  const lengths = await Promise.all(
    allIds.map(async (id) => {
      const lines = await readSessionTranscript(dir, id);
      return JSON.stringify(lines).length;
    }),
  );
  return lengths.reduce((sum, l) => sum + l, 0);
}
