import { describe, it, expect } from "vitest";
import { createLiveTranscript } from "../src/liveTranscript.js";
import { findBoundary } from "mekiri-core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function fakeAssistantMessage(uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "session-under-test",
    parent_tool_use_id: null,
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage;
}

function fakeCompactBoundary(uuid: string): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    session_id: "session-under-test",
    compact_metadata: { trigger: "auto", pre_tokens: 1000 },
  } as unknown as SDKMessage;
}

describe("createLiveTranscript", () => {
  it("turns an assistant message into a searchable RawLine", () => {
    const transcript = createLiveTranscript();
    transcript.push(fakeAssistantMessage("11111111-1111-4111-8111-111111111111", "Reading the logs now to find the root cause."));

    const boundary = findBoundary(transcript.getLines(), "Reading the logs now");
    expect(boundary).toEqual({ status: "ok", uuid: "11111111-1111-4111-8111-111111111111" });
  });

  it("translates a compact boundary message into a two-line pair findLastCompactBoundaryIndex recognizes", () => {
    const transcript = createLiveTranscript();
    transcript.push(fakeAssistantMessage("22222222-2222-4222-8222-222222222222", "Before the compaction, this text appears."));
    transcript.push(fakeCompactBoundary("33333333-3333-4333-8333-333333333333"));
    transcript.push(fakeAssistantMessage("44444444-4444-4444-8444-444444444444", "After the compaction, fresh work begins."));

    const boundary = findBoundary(transcript.getLines(), "Before the compaction, this text appears");
    expect(boundary).toEqual({ status: "in_compacted_zone", lastCompactUuid: "33333333-3333-4333-8333-333333333333" });

    const freshBoundary = findBoundary(transcript.getLines(), "After the compaction, fresh work begins");
    expect(freshBoundary).toEqual({ status: "ok", uuid: "44444444-4444-4444-8444-444444444444" });
  });

  it("ignores message types that carry no searchable text (e.g. a bare system init message)", () => {
    const transcript = createLiveTranscript();
    transcript.push({ type: "system", subtype: "init", session_id: "x", uuid: "u" } as unknown as SDKMessage);
    expect(transcript.getLines()).toEqual([]);
  });
});
