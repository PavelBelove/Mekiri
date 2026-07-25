import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RawLine } from "mekiri-core";
import { createInputQueue } from "./inputQueue.js";
import { createLiveTranscript } from "./liveTranscript.js";
import { buildQueryOptions } from "./permissions.js";

export interface CloneDynamicContext {
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
  onHarvest: (result: string, needsCleanLook: boolean) => void;
}

export interface RunCloneResult {
  result: string;
  harvestedImplicitly: boolean;
  needsCleanLook: boolean;
  branchLength: number;
}

export async function runClone(
  task: string,
  forkedSessionId: string | undefined,
  dir: string,
  buildTools: (dynamic: CloneDynamicContext) => McpSdkServerConfigWithInstance,
): Promise<RunCloneResult> {
  let transcript = createLiveTranscript();
  let currentInput = createInputQueue();
  currentInput.push(task);
  currentInput.close();

  let currentSessionId = forkedSessionId;
  let pendingSwitch: { newSessionId: string; injectText: string } | null = null;
  let harvested: { result: string; needsCleanLook: boolean } | null = null;
  let lastAssistantText = "";

  const tools = buildTools({
    getSessionId: () => {
      if (!currentSessionId) throw new Error("mekiri-host: clone has no active session id yet");
      return currentSessionId;
    },
    getTranscript: () => transcript.getLines(),
    onSwitch: (newSessionId, injectText) => {
      pendingSwitch = { newSessionId, injectText };
    },
    onHarvest: (result, needsCleanLook) => {
      harvested = { result, needsCleanLook };
    },
  });

  while (!harvested) {
    const q = query({
      prompt: currentInput.iterable,
      options: buildQueryOptions({ resume: currentSessionId, cwd: dir, mcpServers: { mekiri: tools } }),
    });

    for await (const message of q) {
      transcript.push(message);

      if (message.type === "system" && message.subtype === "init") {
        currentSessionId = message.session_id;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            lastAssistantText = block.text;
          }
        }
      }

      if (harvested || pendingSwitch) {
        await q.return(undefined);
        break;
      }
    }

    if (harvested) {
      break;
    }

    if (pendingSwitch) {
      const { newSessionId, injectText } = pendingSwitch;
      pendingSwitch = null;
      currentSessionId = newSessionId;
      transcript = createLiveTranscript();
      currentInput = createInputQueue();
      currentInput.push(injectText);
      currentInput.close();
      continue;
    }

    // The turn ended naturally: no tool call switched or harvested. Soft
    // fallback per the design spec — the clone's last text becomes the
    // result rather than treating this as an error.
    return {
      result: lastAssistantText,
      harvestedImplicitly: true,
      needsCleanLook: false,
      branchLength: JSON.stringify(transcript.getLines()).length,
    };
  }

  const finalHarvest = harvested as { result: string; needsCleanLook: boolean };
  return {
    result: finalHarvest.result,
    harvestedImplicitly: false,
    needsCleanLook: finalHarvest.needsCleanLook,
    branchLength: JSON.stringify(transcript.getLines()).length,
  };
}
