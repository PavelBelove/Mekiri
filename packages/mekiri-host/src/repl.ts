import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
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
// "prune"). Everything else (Bash, file edits, other MCP servers, etc.)
// falls through to the SDK's normal/default permission handling by
// returning null. Matching the "mcp__mekiri__" prefix rather than the
// single literal "mcp__mekiri__prune" keeps this future-proof: any tool
// added to createMekiriTools later is auto-approved without another repl.ts
// change, and the prefix can't collide with other servers since the SDK's
// "mcp__<serverName>__<toolName>" naming ties it to the "mekiri" name we
// pass to createSdkMcpServer.
export const canUseTool: CanUseTool = async (toolName) => {
  if (toolName.startsWith("mcp__mekiri__")) {
    return { behavior: "allow" };
  }
  return null;
};

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
        options: {
          resume: currentSessionId,
          cwd: options.dir,
          mcpServers: { mekiri: tools },
          canUseTool,
        },
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
