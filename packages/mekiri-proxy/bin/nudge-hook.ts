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

// Deliberately does not import mekiri-core's configStore/configSchema: this
// binary runs via plain `node --experimental-strip-types` (not `tsx`, unlike
// mcp-server.ts) for hook-invocation latency, and mekiri-core's own internal
// modules cross-import each other with ".js" specifiers that only resolve
// under tsx or a built dist/ -- pulling in "mekiri-core" here throws
// ERR_MODULE_NOT_FOUND. Reads/writes just the one field this hook needs
// directly, tolerating a missing/malformed config.json the same way
// mekiri-core's loadConfig degrades to a default.
async function readDeferCalls(configPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const json = JSON.parse(raw) as { nudge?: { deferCalls?: unknown } };
    const value = json.nudge?.deferCalls;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function clearDeferCalls(configPath: string): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return; // nothing on disk to have granted deferCalls > 0 in the first place
  }
  const nudge = (json.nudge as Record<string, unknown> | undefined) ?? {};
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...json, nudge: { ...nudge, deferCalls: 0 } }, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as {
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
    cwd?: string;
  };

  if (!input.session_id || !input.tool_name) {
    return;
  }

  const dir = input.cwd ?? process.cwd();
  const statePath = path.join(dir, ".mekiri", "hook-state", `${input.session_id}.json`);
  const configPath = path.join(dir, ".mekiri", "config.json");

  const [state, deferCalls] = await Promise.all([loadState(statePath), readDeferCalls(configPath)]);
  const { nextState, additionalContext, block } = decideNudge(
    state,
    input.tool_name,
    input.tool_input,
    deferCalls,
  );

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(nextState), "utf8");

  // One-shot grant: a Mekiri call that just seeded nextState.deferRemaining
  // from deferCalls must not keep re-granting it on every future reset, so
  // clear it back to 0 on disk right away once consumed.
  if (deferCalls > 0) {
    await clearDeferCalls(configPath);
  }

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
