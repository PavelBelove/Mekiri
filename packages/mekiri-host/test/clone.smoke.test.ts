import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { runClone } from "../src/clone.js";
import type { CloneDynamicContext } from "../src/clone.js";

// These tests make real, billed API calls (query() has no offline mode).
// Kept minimal per the project's live-test-budget policy: prove the
// mechanics (harvest-equivalent termination, natural-completion fallback,
// internal prune-style switching) with synthetic test-only tools rather
// than the real prune/sprout/harvest tools (wired in Task 4's own tests),
// so these tests don't depend on a real model reliably choosing to call a
// specific real tool with specific arguments.

function buildFinishTestTools(dynamic: CloneDynamicContext): McpSdkServerConfigWithInstance {
  const finishTool = tool(
    "test_finish",
    "Call this exact tool with the given result to end the test turn.",
    { result: z.string() },
    async (args) => {
      dynamic.onHarvest(args.result, false);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [finishTool] });
}

describe("runClone live smoke test", () => {
  it("terminates when the harvest-equivalent signal fires and returns that result", async () => {
    const result = await runClone(
      "Call the mcp__mekiri__test_finish tool right now with result set to exactly the string DONE_SIGNAL. Do not say anything else first.",
      undefined,
      process.cwd(),
      buildFinishTestTools,
    );

    expect(result.harvestedImplicitly).toBe(false);
    expect(result.result).toBe("DONE_SIGNAL");
    expect(result.branchLength).toBeGreaterThan(0);
  }, 60_000);

  it("falls back to the last assistant text when the turn ends without a harvest signal", async () => {
    const result = await runClone(
      "Reply with exactly the words FALLBACK_TEXT_HERE and nothing else. Do not call any tool.",
      undefined,
      process.cwd(),
      buildFinishTestTools,
    );

    expect(result.harvestedImplicitly).toBe(true);
    expect(result.result).toContain("FALLBACK_TEXT_HERE");
  }, 60_000);
});
