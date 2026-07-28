import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline";
import { createClaudeCodeBackend } from "mekiri-core";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { createMekiriTools } from "./tools.js";
import { buildQueryOptions, formatQueryErrorMessage } from "./permissions.js";
import { createAsyncSproutLimiter } from "./asyncSproutLimiter.js";

export { canUseTool, buildQueryOptions, formatQueryErrorMessage } from "./permissions.js";

export interface ReplOptions {
  resumeSessionId?: string;
  dir: string;
  trusted?: boolean;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  let currentInput = createInputQueue();
  let transcript = createLiveTranscript();
  let currentSessionId = options.resumeSessionId;
  let pendingSwitch: { newSessionId: string; injectText: string } | null = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => currentInput.push(line));

  const asyncSproutLimiter = createAsyncSproutLimiter();
  const backend = createClaudeCodeBackend();

  const tools = createMekiriTools({
    dir: options.dir,
    depth: 0,
    isClone: false,
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
    onHarvest: () => {
      // Unreachable: handleHarvest checks context.isClone (false here, the
      // parent is never a clone) and returns an error result before ever
      // calling this callback. Present only to satisfy the type.
      throw new Error("mekiri-host: onHarvest should never be invoked at the parent (isClone: false)");
    },
    asyncSproutLimiter,
    onAsyncSproutComplete: (injectText) => {
      currentInput.push(injectText);
    },
    backend,
    trusted: options.trusted,
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
          trusted: options.trusted,
        }),
      });

      try {
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
      } catch (error) {
        // A transient failure from query() or the underlying stream (auth
        // expiry, rate limit, network blip) must not crash the whole REPL.
        // Report it honestly and go back to the top of the while loop with
        // currentSessionId untouched, so the next line the user types
        // starts a fresh query({ resume: currentSessionId, ... }) instead
        // of losing the session to an unhandled rejection.
        //
        // Also clear any pendingSwitch: in the rare case the error came
        // from q.return(undefined) itself (called above because a switch
        // was already pending), leaving it set would make the *next*
        // successful loop iteration act on a switch request that belongs
        // to this failed turn, not the new one.
        pendingSwitch = null;
        process.stderr.write(`\n${formatQueryErrorMessage(error)}\n`);
        continue;
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
