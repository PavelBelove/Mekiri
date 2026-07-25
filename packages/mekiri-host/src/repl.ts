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
// Supplying any canUseTool callback makes the SDK route every
// prompt-requiring tool decision through it (there is no partial opt-in) —
// but read-only tools like Read/Grep/Glob are auto-approved by the SDK's own
// default handling before they ever reach this callback (mirroring Claude
// Code's normal UX, where read-only operations don't prompt). This was
// confirmed by real dogfooding: reading a real file from this repo worked
// fine in live runs of this REPL both before and after this callback was
// added. Only tools that would normally need an approval prompt — Bash,
// Edit, Write, and any other MCP server's tools — actually reach here, and
// the SDK's own contract for CanUseTool is fail-closed: returning `null`
// means "the consumer already sent a control_response out-of-band," and if
// that's not true the tool stays blocked indefinitely with no error
// surfaced anywhere. This host does not do out-of-band responses, so `null`
// is never a safe return value here — it would silently reintroduce the
// exact hang this callback exists to fix, just without even a visible
// "needs your permission" message. Returning an explicit `deny` instead
// fails fast and visibly: the model sees the denial and can tell the user
// mekiri-host doesn't support interactive tool-permission prompts yet.
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

// Formats a thrown query()/stream error (auth expiry, rate limit, network
// blip, etc.) into the message shown to the user when the live turn loop
// inside runRepl() fails mid-session. Kept as a small pure function so the
// "don't crash, tell the user honestly, keep currentSessionId, let them
// resume" behavior can be unit-tested without needing to trigger a real
// query() failure — those aren't reproducible deterministically in a fast
// test, and aren't worth the live API cost/flakiness to force.
export function formatQueryErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `mekiri-host: query error: ${detail}. Type your next message to try resuming this session, or Ctrl+C to exit.`;
}

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
