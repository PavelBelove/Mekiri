import { describe, it, expect } from "vitest";
import { rewriteMessages } from "../src/rewriteMessages.js";
import type { RewriteRule } from "../src/rewriteMessages.js";

function pruneToolUse(id: string, quote: string, name = "prune") {
  return { type: "tool_use", id, name, input: { quote, note_type: "portal", fruit: {}, keep_code: false } };
}

function pruneToolResult(toolUseId: string, ruleId: string) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: JSON.stringify({ status: "ok", rule_id: ruleId, distillate: "distillate text" }) }],
  };
}

// Every tool_result block's tool_use_id must resolve against a tool_use block
// in the immediately preceding message -- mirrors the API's own pairing rule.
function assertNoOrphanToolResults(messages: unknown[]) {
  for (let i = 0; i < messages.length; i++) {
    const content = (messages[i] as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as { type?: string }).type !== "tool_result") continue;
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
      const prevContent = i > 0 ? (messages[i - 1] as { content?: unknown }).content : undefined;
      const prevToolUseIds = Array.isArray(prevContent)
        ? prevContent.filter((b) => (b as { type?: string }).type === "tool_use").map((b) => (b as { id?: string }).id)
        : [];
      expect(prevToolUseIds).toContain(toolUseId);
    }
  }
}

describe("rewriteMessages", () => {
  it("returns messages unchanged when rules is undefined or empty", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(rewriteMessages(messages, undefined)).toBe(messages);
    expect(rewriteMessages(messages, [])).toBe(messages);
  });

  it("keeps the prefix before quote, cuts [quote, own prune call), keeps the anchor and the tail", () => {
    const messages = [
      { role: "user", content: "start task" }, // 0 -- must survive: this is the original request
      { role: "assistant", content: [{ type: "text", text: "reply1 is where garbage begins" }] }, // 1 -- cut
      { role: "user", content: "turn2" }, // 2 -- cut
      { role: "assistant", content: [pruneToolUse("toolu_prune1", "reply1 is where garbage begins")] }, // 3 -- kept (anchor)
      { role: "user", content: [pruneToolResult("toolu_prune1", "RULE_1")] }, // 4 -- kept (carries distillate)
      { role: "assistant", content: [{ type: "text", text: "turn5" }] }, // 5 -- kept
    ];
    const rule: RewriteRule = { id: "RULE_1", matchQuote: "reply1 is where garbage begins" };

    const result = rewriteMessages(messages, [rule]);

    expect(result).toEqual([messages[0], messages[3], messages[4], messages[5]]);
    assertNoOrphanToolResults(result);
  });

  it("matches a quote that is a substring of a larger text block", () => {
    const messages = [
      { role: "user", content: "turn0" }, // 0 kept
      { role: "assistant", content: [{ type: "text", text: "Sure, here's the plan: step one is to set up the repo." }] }, // 1 cut
      { role: "user", content: "turn2" }, // 2 cut
      { role: "assistant", content: [pruneToolUse("toolu_S", "step one is to set up the repo")] }, // 3 kept
      { role: "user", content: [pruneToolResult("toolu_S", "RULE_S")] }, // 4 kept
      { role: "user", content: "turn5" }, // 5 kept
    ];
    const rule: RewriteRule = { id: "RULE_S", matchQuote: "step one is to set up the repo" };

    expect(rewriteMessages(messages, [rule])).toEqual([messages[0], messages[3], messages[4], messages[5]]);
  });

  it("applies two independent rules in the same session cumulatively, not overwriting each other", () => {
    const messages = [
      { role: "user", content: "turn0" }, // 0 kept
      { role: "assistant", content: [{ type: "text", text: "quoteA" }] }, // 1 cut (range A)
      { role: "user", content: "turn2" }, // 2 cut (range A)
      { role: "assistant", content: [pruneToolUse("toolu_A", "quoteA")] }, // 3 kept
      { role: "user", content: [pruneToolResult("toolu_A", "RULE_A")] }, // 4 kept
      { role: "user", content: "turn5" }, // 5 kept
      { role: "assistant", content: [{ type: "text", text: "quoteB" }] }, // 6 cut (range B)
      { role: "user", content: "turn7" }, // 7 cut (range B)
      { role: "assistant", content: [pruneToolUse("toolu_B", "quoteB")] }, // 8 kept
      { role: "user", content: [pruneToolResult("toolu_B", "RULE_B")] }, // 9 kept
      { role: "user", content: "turn10" }, // 10 kept
    ];
    const rules: RewriteRule[] = [
      { id: "RULE_A", matchQuote: "quoteA" },
      { id: "RULE_B", matchQuote: "quoteB" },
    ];

    const result = rewriteMessages(messages, rules);

    expect(result).toEqual([
      messages[0],
      messages[3],
      messages[4],
      messages[5],
      messages[8],
      messages[9],
      messages[10],
    ]);
    assertNoOrphanToolResults(result);
  });

  it("lets a later, longer-reaching rule swallow an earlier rule's own anchor", () => {
    const messages = [
      { role: "user", content: "start task" }, // 0 kept -- survives both cuts
      { role: "assistant", content: [{ type: "text", text: "early note" }] }, // 1 cut (range C starts here)
      { role: "user", content: "u2" }, // 2 cut
      { role: "assistant", content: [{ type: "text", text: "quoteA" }] }, // 3 cut
      { role: "user", content: "u4" }, // 4 cut
      { role: "assistant", content: [pruneToolUse("toolu_A", "quoteA")] }, // 5 cut -- rule A's own anchor, swallowed by C
      { role: "user", content: [pruneToolResult("toolu_A", "RULE_A")] }, // 6 cut -- ditto
      { role: "user", content: "u7" }, // 7 cut
      { role: "assistant", content: [pruneToolUse("toolu_C", "early note")] }, // 8 kept -- rule C's own anchor
      { role: "user", content: [pruneToolResult("toolu_C", "RULE_C")] }, // 9 kept
      { role: "user", content: "u10" }, // 10 kept
    ];
    const rules: RewriteRule[] = [
      { id: "RULE_A", matchQuote: "quoteA" },
      { id: "RULE_C", matchQuote: "early note" },
    ];

    const result = rewriteMessages(messages, rules);

    expect(result).toEqual([messages[0], messages[8], messages[9], messages[10]]);
    assertNoOrphanToolResults(result);
    expect(JSON.stringify(result)).not.toContain("RULE_A");
  });

  it("skips a rule whose own prune call hasn't reached this request's array yet, but still applies the others", () => {
    const messages = [
      { role: "user", content: "start" }, // 0 kept
      { role: "assistant", content: [{ type: "text", text: "validQuote" }] }, // 1 cut
      { role: "user", content: "u2" }, // 2 cut
      { role: "assistant", content: [pruneToolUse("toolu_V", "validQuote")] }, // 3 kept
      { role: "user", content: [pruneToolResult("toolu_V", "RULE_VALID")] }, // 4 kept
      { role: "user", content: "u5" }, // 5 kept
      { role: "assistant", content: [{ type: "text", text: "futureQuote" }] }, // 6 kept -- RULE_FUTURE's own prune call isn't in this array yet
      { role: "user", content: "u7" }, // 7 kept
    ];
    const rules: RewriteRule[] = [
      { id: "RULE_VALID", matchQuote: "validQuote" },
      { id: "RULE_FUTURE", matchQuote: "futureQuote" },
    ];

    const result = rewriteMessages(messages, rules);

    expect(result).toEqual([messages[0], messages[3], messages[4], messages[5], messages[6], messages[7]]);
  });

  it("returns messages unchanged when a rule's matchQuote is not found, even if its prune call is present", () => {
    const messages = [
      { role: "user", content: "turn0" },
      { role: "assistant", content: [{ type: "text", text: "unrelated text" }] },
      { role: "assistant", content: [pruneToolUse("toolu_N", "text that never appears anywhere")] },
      { role: "user", content: [pruneToolResult("toolu_N", "RULE_N")] },
    ];
    const rule: RewriteRule = { id: "RULE_N", matchQuote: "text that never appears anywhere" };

    expect(rewriteMessages(messages, [rule])).toEqual(messages);
  });

  it("resolves the anchor when the tool_use name is MCP-qualified, as real Claude Code traffic sends it (mcp__mekiri-proxy__prune, not bare 'prune')", () => {
    const messages = [
      { role: "user", content: "start task" }, // 0 kept
      { role: "assistant", content: [{ type: "text", text: "reply1 is where garbage begins" }] }, // 1 cut
      { role: "user", content: "turn2" }, // 2 cut
      {
        role: "assistant",
        content: [pruneToolUse("toolu_prune1", "reply1 is where garbage begins", "mcp__mekiri-proxy__prune")],
      }, // 3 kept (anchor)
      { role: "user", content: [pruneToolResult("toolu_prune1", "RULE_1")] }, // 4 kept
      { role: "assistant", content: [{ type: "text", text: "turn5" }] }, // 5 kept
    ];
    const rule: RewriteRule = { id: "RULE_1", matchQuote: "reply1 is where garbage begins" };

    const result = rewriteMessages(messages, [rule]);

    expect(result).toEqual([messages[0], messages[3], messages[4], messages[5]]);
    assertNoOrphanToolResults(result);
  });

  it("resolves the anchor for mekiri-host's own MCP-qualified name (mcp__mekiri__prune)", () => {
    const messages = [
      { role: "user", content: "start task" }, // 0 kept
      { role: "assistant", content: [{ type: "text", text: "garbage from host path" }] }, // 1 cut
      { role: "assistant", content: [pruneToolUse("toolu_host1", "garbage from host path", "mcp__mekiri__prune")] }, // 2 kept
      { role: "user", content: [pruneToolResult("toolu_host1", "RULE_HOST")] }, // 3 kept
    ];
    const rule: RewriteRule = { id: "RULE_HOST", matchQuote: "garbage from host path" };

    expect(rewriteMessages(messages, [rule])).toEqual([messages[0], messages[2], messages[3]]);
  });

  it("does not mutate the original messages array", () => {
    const messages = [
      { role: "user", content: "turn0" },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
      { role: "assistant", content: [pruneToolUse("toolu_M", "reply1")] },
      { role: "user", content: [pruneToolResult("toolu_M", "RULE_M")] },
    ];
    const original = JSON.parse(JSON.stringify(messages));
    rewriteMessages(messages, [{ id: "RULE_M", matchQuote: "reply1" }]);
    expect(messages).toEqual(original);
  });
});
