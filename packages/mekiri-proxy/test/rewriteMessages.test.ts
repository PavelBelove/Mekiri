import { describe, it, expect } from "vitest";
import { rewriteMessages } from "../src/rewriteMessages.js";

describe("rewriteMessages", () => {
  it("returns messages unchanged when no rule is active", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(rewriteMessages(messages, undefined)).toBe(messages);
  });

  it("replaces everything before keepFromIndex with the rule's replacement", () => {
    const messages = [
      { role: "user", content: "turn1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "turn2" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "turn3" },
    ];
    const rule = {
      keepFromIndex: 4,
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

  it("keeps everything when keepFromIndex is 0", () => {
    const messages = [{ role: "user", content: "turn1" }];
    const rule = { keepFromIndex: 0, replacement: [] };
    expect(rewriteMessages(messages, rule)).toEqual([{ role: "user", content: "turn1" }]);
  });

  it("does not mutate the original messages array", () => {
    const messages = [{ role: "user", content: "turn1" }, { role: "assistant", content: "reply1" }];
    const original = JSON.parse(JSON.stringify(messages));
    rewriteMessages(messages, { keepFromIndex: 1, replacement: [{ role: "user", content: "note" }] });
    expect(messages).toEqual(original);
  });
});
