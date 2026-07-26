import type { AuditEntry, PruneAuditEntry, SproutAuditEntry } from "mekiri-core";
import { distillationRatio, branchCompression } from "mekiri-core";

// These four numbers must stay in sync with the placeholder thresholds
// stated in prose in packages/mekiri-host/skills-plugin/skills/mekiri-tuning/SKILL.md
// (Trigger B) -- there is no code-level DRY across the code/markdown
// boundary, only this cross-reference comment.
const DR_THRESHOLD = 2;
const DR_MIN_CONSECUTIVE = 3;
const BC_THRESHOLD = 2;
const BC_MIN_CONSECUTIVE = 2;

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Detects mekiri-tuning's Trigger B (sustained low-compression signal) from
 * a project's full audit log. Only entries after the last configure_mekiri
 * event count (anti-nag: a signal the user already acted on should not keep
 * resurfacing every session). Returns undefined when nothing is actionable.
 */
export function computeTuningSignalContext(entries: AuditEntry[]): string | undefined {
  const lastConfigureIndex = entries.map((entry) => entry.event).lastIndexOf("configure_mekiri");
  const relevant = lastConfigureIndex === -1 ? entries : entries.slice(lastConfigureIndex + 1);

  const recentPruneRatios = relevant
    .filter((entry): entry is PruneAuditEntry => entry.event === "prune")
    .slice(-DR_MIN_CONSECUTIVE)
    .map(distillationRatio);
  const pruneAvg = recentPruneRatios.length === DR_MIN_CONSECUTIVE ? average(recentPruneRatios) : undefined;
  const pruneSignal = pruneAvg !== undefined && pruneAvg < DR_THRESHOLD ? pruneAvg : undefined;

  const recentSproutRatios = relevant
    .filter((entry): entry is SproutAuditEntry => entry.event === "sprout")
    .slice(-BC_MIN_CONSECUTIVE)
    .map(branchCompression);
  const sproutAvg = recentSproutRatios.length === BC_MIN_CONSECUTIVE ? average(recentSproutRatios) : undefined;
  const sproutSignal = sproutAvg !== undefined && sproutAvg < BC_THRESHOLD ? sproutAvg : undefined;

  if (pruneSignal === undefined && sproutSignal === undefined) {
    return undefined;
  }

  const lines = ["Mekiri metrics signal (see mekiri-tuning, Trigger B):"];
  if (pruneSignal !== undefined) {
    lines.push(
      `- Distillation Ratio has averaged ${pruneSignal.toFixed(2)}x over the last ${DR_MIN_CONSECUTIVE} prune entries (below the ${DR_THRESHOLD}x placeholder threshold).`,
    );
  }
  if (sproutSignal !== undefined) {
    lines.push(
      `- Branch Compression has averaged ${sproutSignal.toFixed(2)}x over the last ${BC_MIN_CONSECUTIVE} sprout entries (below the ${BC_THRESHOLD}x placeholder threshold).`,
    );
  }
  lines.push("Consult the mekiri-tuning skill before deciding whether to raise this with the user.");
  return lines.join("\n");
}
