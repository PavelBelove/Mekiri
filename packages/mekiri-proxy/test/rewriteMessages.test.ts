import { describe, it, expect } from "vitest";
import { rewriteMessages } from "../src/rewriteMessages.js";

describe("rewriteMessages", () => {
  it("returns messages unchanged when no rule is active", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(rewriteMessages(messages, undefined)).toBe(messages);
  });

  it("replaces everything up to and including the matched assistant turn with the rule's replacement", () => {
    const messages = [
      { role: "user", content: "turn1" },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
      { role: "user", content: "turn2" },
      { role: "assistant", content: [{ type: "text", text: "the answer you're looking for is 42" }] },
      { role: "user", content: "turn3" },
    ];
    const rule = {
      matchQuote: "the answer you're looking for is 42",
      replacement: [
        { role: "user" as const, content: "[MEKIRI PORTAL] cut everything before this." },
        { role: "assistant" as const, content: "distillate: turns 1-2 were about X." },
      ],
    };
    const result = rewriteMessages(messages, rule);
    expect(result).toEqual([
      { role: "user", content: "[MEKIRI PORTAL] cut everything before this." },
      { role: "assistant", content: "distillate: turns 1-2 were about X." },
      { role: "user", content: "turn3" },
    ]);
  });

  it("matches a quote that is a substring of a larger text block, keeping only messages after it", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Sure, here's the plan: step one is to set up the repo." }],
      },
      { role: "user", content: "turn1" },
    ];
    const rule = { matchQuote: "step one is to set up the repo", replacement: [] };
    expect(rewriteMessages(messages, rule)).toEqual([{ role: "user", content: "turn1" }]);
  });

  it("returns messages unchanged when the quote is not found in this array", () => {
    const messages = [
      { role: "user", content: "turn1" },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
    ];
    const rule = { matchQuote: "text that never appears anywhere", replacement: [{ role: "user" as const, content: "note" }] };
    expect(() => rewriteMessages(messages, rule)).not.toThrow();
    expect(rewriteMessages(messages, rule)).toEqual(messages);
  });

  it("does not mutate the original messages array", () => {
    const messages = [
      { role: "user", content: "turn1" },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
    ];
    const original = JSON.parse(JSON.stringify(messages));
    rewriteMessages(messages, { matchQuote: "reply1", replacement: [{ role: "user", content: "note" }] });
    expect(messages).toEqual(original);
  });
});
