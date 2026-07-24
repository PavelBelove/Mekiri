import { describe, it, expect } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInputQueue } from "../src/inputQueue.js";

// These tests make real, billed API calls. Keep them to the minimum needed
// to prove the wiring this task adds actually works end to end — everything
// beyond this is manual dogfooding per the design spec's explicit choice.
describe("mekiri-host live smoke test", () => {
  it("completes one real turn, captures a session id, and receives assistant text", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let sessionId: string | undefined;
    let sawAssistantText = false;

    const q = query({ prompt: iterable, options: { cwd: process.cwd() } });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantText).toBe(true);
  }, 60_000);

  it("resumes a session by id and the resumed query's init message reports the same session id", async () => {
    const first = createInputQueue();
    first.push("Reply with exactly one word: ok");
    first.close();

    let firstSessionId: string | undefined;
    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") firstSessionId = message.session_id;
    }
    expect(firstSessionId).toBeTruthy();

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    const q2 = query({ prompt: second.iterable, options: { resume: firstSessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") secondSessionId = message.session_id;
    }

    expect(secondSessionId).toBe(firstSessionId);
  }, 60_000);
});
