import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { createMekiriTools } from "./tools.js";

export interface ReplOptions {
  resumeSessionId?: string;
  dir: string;
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
  while (running) {
    const q = query({
      prompt: currentInput.iterable,
      options: {
        resume: currentSessionId,
        cwd: options.dir,
        mcpServers: { mekiri: tools },
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

  rl.close();
}
