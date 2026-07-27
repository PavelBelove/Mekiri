import { computeProjectReport } from "mekiri-core";

function formatPercent(fraction: number): string {
  if (fraction === Infinity) {
    return ">1000% (virtual reconstruction crossed threshold before any real turns)";
  }
  if (Number.isNaN(fraction)) {
    return "n/a";
  }
  return `${(fraction * 100).toFixed(1)}%`;
}

function printHumanReadable(report: Awaited<ReturnType<typeof computeProjectReport>>): void {
  if (report.trees.length === 0) {
    console.log("No session trees found in .mekiri/audit.jsonl -- nothing to report yet.");
    return;
  }
  for (const tree of report.trees) {
    console.log(`\nSession tree rooted at ${tree.rootSessionId}`);
    console.log(
      `  prune events: ${tree.pruneCount}` +
        (tree.averageDistillationRatio !== undefined ? ` (avg Distillation Ratio: ${tree.averageDistillationRatio.toFixed(2)}x)` : ""),
    );
    console.log(
      `  sprout events: ${tree.sproutCount}` +
        (tree.averageBranchCompression !== undefined ? ` (avg Branch Compression: ${tree.averageBranchCompression.toFixed(2)}x)` : ""),
    );
    console.log(`  Lifetime Token Savings: ${tree.totalLifetimeTokenSavings} chars`);
    console.log(`  Context Recycling Ratio: ${formatPercent(tree.contextRecyclingRatio)}`);
    if (tree.virtualContextLifetime) {
      console.log(
        `  Virtual Context Lifetime: actual turn ${tree.virtualContextLifetime.actualTurn}, virtual turn ${tree.virtualContextLifetime.virtualTurn} -- ${formatPercent(tree.virtualContextLifetime.lifetimeExtension)} extension`,
      );
    } else {
      console.log("  Virtual Context Lifetime: not enough data (trunk never compacted)");
    }
  }
}

async function main(): Promise<void> {
  const dirIndex = process.argv.indexOf("--dir");
  const dir = dirIndex !== -1 ? process.argv[dirIndex + 1] : process.cwd();
  const asJson = process.argv.includes("--json");

  const report = await computeProjectReport(dir);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReadable(report);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
