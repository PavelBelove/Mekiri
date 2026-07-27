import type { PruneAuditEntry } from "./auditLog.js";
import { findLastCompactBoundaryIndex } from "./compactZone.js";
import { lifetimeTokenSavings, virtualContextLifetime } from "./metrics.js";
import { readSessionTranscript } from "./sessionTranscript.js";
import { findPruneTrunk } from "./sessionTree.js";
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

export interface VirtualContextLifetimeResult {
  actualTurn: number;
  virtualTurn: number;
  lifetimeExtension: number;
}

/**
 * See design spec §4 and this plan's Global Constraints for the full
 * derivation. Only the trunk tip's own transcript is read -- no
 * multi-session concatenation needed. priorGarbage (every earlier prune's
 * removed length along the trunk, excluding the tip itself) is added as a
 * head start to the virtual cumulative-length walk instead of starting at
 * 0, which reproduces the same result as a full reconstruction with one
 * file read instead of N.
 */
export async function computeVirtualContextLifetime(dir: string, tree: SessionTree): Promise<VirtualContextLifetimeResult | undefined> {
  const trunk = findPruneTrunk(tree);
  const tipSessionId = trunk.length > 0 ? trunk[trunk.length - 1].sessionId : tree.rootSessionId;

  const tipTranscript = await readSessionTranscript(dir, tipSessionId);
  const actualTurn = findLastCompactBoundaryIndex(tipTranscript);
  if (actualTurn === -1) {
    return undefined;
  }

  // Same length basis as the accumulation loop below (sum of each line's own
  // JSON.stringify length) -- NOT JSON.stringify(slice).length, which would
  // add array bracket/comma overhead the per-line walk never accrues and
  // throw off the equality check by a few bytes.
  const threshold = tipTranscript.slice(0, actualTurn + 1).reduce((sum, line) => sum + JSON.stringify(line).length, 0);
  const priorGarbage = trunk.slice(0, -1).reduce((sum, node) => sum + node.removedOrBranchLength, 0);

  let virtualCumulative = priorGarbage;
  let virtualTurn = tipTranscript.length;
  for (let i = 0; i < tipTranscript.length; i++) {
    virtualCumulative += JSON.stringify(tipTranscript[i]).length;
    if (virtualCumulative >= threshold) {
      virtualTurn = i;
      break;
    }
  }

  return {
    actualTurn,
    virtualTurn,
    lifetimeExtension: virtualContextLifetime(actualTurn, virtualTurn),
  };
}
