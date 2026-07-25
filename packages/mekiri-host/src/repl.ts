import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { createMekiriTools } from "./tools.js";

export interface ReplOptions {
  resumeSessionId?: string;
  dir: string;
}

// mekiri-host is only responsible for permissioning its own MCP tool(s) —
// the "mekiri" server registered by createMekiriTools (currently just
// "prune"). Everything else (Bash, file edits, other MCP servers, etc.) is
// explicitly DENIED rather than falling through to any "default" handling.
//
// This matters because supplying any canUseTool callback at all makes the
// SDK route every tool-permission decision for the whole session through
// this function (there is no partial opt-in) — and the SDK's own contract
// for CanUseTool is fail-closed: returning `null` means "the consumer
// already sent a control_response out-of-band," and if that's not true the
// tool stays blocked indefinitely with no error surfaced anywhere. This
// host does not do out-of-band responses, so `null` is never a safe return
// value here — it would silently reintroduce the exact hang this callback
// exists to fix, just without even a visible "needs your permission"
// message. Returning an explicit `deny` instead fails fast and visibly: the
// model sees the denial and can tell the user mekiri-host doesn't support
// interactive tool-permission prompts yet.
//
// Matching the "mcp__mekiri__" prefix rather than the single literal
// "mcp__mekiri__prune" keeps the allow side future-proof: any tool added to
// createMekiriTools later is auto-approved without another repl.ts change,
// and the prefix can't collide with other servers since the SDK's
// "mcp__<serverName>__<toolName>" naming ties it to the "mekiri" name we
// pass to createSdkMcpServer.
export const canUseTool: CanUseTool = async (toolName) => {
  if (toolName.startsWith("mcp__mekiri__")) {
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message:
      "mekiri-host is a minimal REPL that doesn't yet support interactive tool-permission prompts; only mekiri's own tools (mcp__mekiri__*) are auto-approved in this iteration.",
  };
};

// Builds the exact options object passed to query() inside runRepl(), split
// out so tests can assert on runRepl's real code path (that canUseTool is
// actually wired in) instead of only on the standalone canUseTool export.
export function buildQueryOptions(context: {
  resume: string | undefined;
  cwd: string;
  mcpServers: Options["mcpServers"];
}): Options {
  return {
    resume: context.resume,
    cwd: context.cwd,
    mcpServers: context.mcpServers,
    canUseTool,
  };
}

export async function runRepl(options: ReplOptions): Promise<void> {
  let currentInput = createInputQueue();
  let transcript = createLiveTranscript();
  let currentSessionId = options.resumeSessionId;
  let pendingSwitch: { newSessionId: string; injectText: string } | null = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => currentInput.push(line));

  const tools = createMekiriTools({
    dir: options.dir,
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
  });

  let running = true;
  try {
    while (running) {
      const q = query({
        prompt: currentInput.iterable,
        options: buildQueryOptions({
          resume: currentSessionId,
          cwd: options.dir,
          mcpServers: { mekiri: tools },
        }),
      });

      for await (const message of q) {
        transcript.push(message);

        if (message.type === "system" && message.subtype === "init") {
          currentSessionId = message.session_id;
        }

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              process.stdout.write(block.text);
            }
          }
        }

        if (pendingSwitch) {
          await q.return(undefined);
          break;
        }
      }

      if (pendingSwitch) {
        const { newSessionId, injectText } = pendingSwitch;
        pendingSwitch = null;
        currentSessionId = newSessionId;
        transcript = createLiveTranscript();
        currentInput = createInputQueue();
        currentInput.push(injectText);
        continue;
      }

      running = false;
    }
  } finally {
    rl.close();
  }
}
