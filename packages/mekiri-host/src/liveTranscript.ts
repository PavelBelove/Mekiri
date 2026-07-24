import type { RawLine } from "mekiri-core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface LiveTranscript {
  push(message: SDKMessage): void;
  getLines(): RawLine[];
}

export function createLiveTranscript(): LiveTranscript {
  const lines: RawLine[] = [];

  function push(message: SDKMessage): void {
    if (message.type === "assistant") {
      lines.push({
        type: "assistant",
        uuid: message.uuid,
        parentUuid: null,
        isSidechain: false,
        message: {
          role: "assistant",
          content: message.message.content as unknown as Array<{ type: string; text?: string }>,
        },
      });
      return;
    }

    if (message.type === "system" && (message as { subtype?: string }).subtype === "compact_boundary") {
      const compactMessage = message as { uuid: string; compact_metadata: unknown };
      lines.push({ type: "system", compactMetadata: compactMessage.compact_metadata });
      lines.push({
        type: "user",
        uuid: compactMessage.uuid,
        parentUuid: null,
        isSidechain: false,
        isCompactSummary: true,
      });
      return;
    }
  }

  function getLines(): RawLine[] {
    return lines;
  }

  return { push, getLines };
}
