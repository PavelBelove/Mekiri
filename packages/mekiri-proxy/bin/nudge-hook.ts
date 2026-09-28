import { promises as fs } from "node:fs";
import path from "node:path";
import { decideNudge } from "../src/nudgeHook.ts";
import { loadHookState, saveHookState } from "../src/hookState.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  // CLAUDE_PROJECT_DIR first: `input.cwd` follows the agent's own `cd`, and a
  // `cd` into a subdirectory silently split this session's state into a second
  // `.mekiri/hook-state` file there, never reset by the MCP server's prune
  // (which keys on the project root) -- a phantom hard block.
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const configPath = path.join(dir, ".mekiri", "config.json");

  const [hookState, deferCalls] = await Promise.all([
    loadHookState(dir, input.session_id),
    readDeferCalls(configPath),
  ]);
  const { nextState, additionalContext, block } = decideNudge(
    hookState?.nudge,
    input.tool_name,
    input.tool_input,
    deferCalls,
  );

  // Only this hook's own slice (.nudge) is ever written here -- .stopBoundary
  // (set by bin/stop-hook.ts, consumed by mcpServer.ts's prune handler) must
  // survive untouched across PostToolUse firings in between, so the full
  // prior state is read back and spread rather than overwritten wholesale.
  await saveHookState(dir, input.session_id, { ...hookState, nudge: nextState });

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
