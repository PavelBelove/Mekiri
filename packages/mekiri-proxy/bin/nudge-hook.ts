import { promises as fs } from "node:fs";
import path from "node:path";
import { decideNudge } from "../src/nudgeHook.ts";
import type { NudgeState } from "../src/nudgeHook.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadState(filePath: string): Promise<NudgeState | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as NudgeState;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as { session_id?: string; tool_name?: string; cwd?: string };

  if (!input.session_id || !input.tool_name) {
    return;
  }

  const dir = input.cwd ?? process.cwd();
  const statePath = path.join(dir, ".mekiri", "hook-state", `${input.session_id}.json`);

  const state = await loadState(statePath);
  const { nextState, additionalContext, block } = decideNudge(state, input.tool_name);

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(nextState), "utf8");

  if (block !== undefined) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: block.reason }));
  } else if (additionalContext !== undefined) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }),
    );
  }
}

main().catch(() => {
  process.exit(0);
});
