import { promises as fs } from "node:fs";
import path from "node:path";
import { decideStopHook } from "../src/stopHook.ts";
import { loadHookState, saveHookState } from "../src/hookState.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Deliberately does not import mekiri-core (same reasoning as
// bin/nudge-hook.ts): this binary runs via plain `node
// --experimental-strip-types`, and mekiri-core's cross-module ".js"
// specifiers only resolve under tsx or a built dist/. Reads just the one
// field this hook needs directly, defaulting to disabled (the schema's own
// default) on any read/parse failure.
async function readStopHookEnabled(configPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const json = JSON.parse(raw) as { stopHook?: { enabled?: unknown } };
    return json.stopHook?.enabled === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as {
    session_id?: string;
    last_assistant_message?: string;
    stop_hook_active?: boolean;
    cwd?: string;
  };

  if (!input.session_id) {
    return;
  }

  // CLAUDE_PROJECT_DIR first, same reason as bin/nudge-hook.ts: `input.cwd`
  // follows the agent's `cd`, which would read stopHook.enabled from the wrong
  // config and leave stopBoundary where prune never looks.
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const configPath = path.join(dir, ".mekiri", "config.json");

  const [hookState, enabled] = await Promise.all([
    loadHookState(dir, input.session_id),
    readStopHookEnabled(configPath),
  ]);

  const { nextState, block } = decideStopHook(
    hookState,
    {
      lastAssistantMessage: input.last_assistant_message ?? "",
      stopHookActive: input.stop_hook_active === true,
    },
    { enabled },
  );

  await saveHookState(dir, input.session_id, nextState);

  // Block protocol: JSON on stdout with `exit 0`, same shape bin/nudge-hook.ts
  // already uses for PostToolUse -- `{"decision":"block","reason":...}`.
  // Confirmed against the official Claude Code hooks reference
  // (https://code.claude.com/docs/en/hooks, Stop hook section): both this
  // JSON-on-stdout form and `exit code 2` + stderr reason block Stop
  // identically ("Prevents Claude from stopping, continues the
  // conversation"), so either protocol works -- this file keeps the
  // JSON form for consistency with nudge-hook.ts. The same docs confirm
  // `stop_hook_active` is a real, documented field set specifically for this
  // loop-guard use ("indicates whether the conversation is already in a
  // state resulting from a previous Stop hook blocking termination").
  // This is a documentation-sourced confirmation, not a live fired-hook
  // observation -- if real usage ever shows different behavior, prefer that
  // over this comment.
  if (block !== undefined) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: block.reason }));
  }
}

main().catch(() => {
  process.exit(0);
});
