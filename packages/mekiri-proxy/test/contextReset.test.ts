import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Wire shapes as Claude Code sends them; texts shortened.
const reminder = { type: "text", text: "<system-reminder>\nCLAUDE.md: respond in Russian\n</system-reminder>" };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name = "Bash") => ({ role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] });
const result = (id: string, text = "ok") => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
const big = (n: number) => "x".repeat(n);

const settings = { enabled: true, thresholdTokens: 0, tailTokens: 20000, tailTurns: 4 };

describe("contextReset", () => {
  let stateDir: string;
  let projectDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-reset-state-"));
    projectDir = mkdtempSync(path.join(tmpdir(), "mekiri-reset-project-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("estimateTokens / resolveThreshold", () => {
    it("ignores base64 payloads and signatures, counts an image flat and non-ASCII heavier", async () => {
      const { estimateTokens } = await import("../src/contextReset.js");
      const image = { type: "image", source: { type: "base64", media_type: "image/png", data: big(100_000) } };
      expect(estimateTokens([image])).toBe(1600 + Math.ceil("imagebase64image/png".length / 3.2));
      expect(estimateTokens({ type: "thinking", thinking: "", signature: big(5000) })).toBe(Math.ceil("thinking".length / 3.2));
      expect(estimateTokens("привет")).toBeGreaterThan(estimateTokens("privet"));
    });

    it("auto threshold sits below Claude Code's compaction point; an explicit value wins", async () => {
      const { resolveThreshold } = await import("../src/contextReset.js");
      expect(resolveThreshold(0, undefined)).toBe(Math.floor(187_000 * 0.9));
      expect(resolveThreshold(0, "foo,context-1m-2025-08-07")).toBe(Math.floor(987_000 * 0.9));
      expect(resolveThreshold(50_000, "context-1m")).toBe(50_000);
    });
  });

  describe("chooseCut", () => {
    it("cuts right at the last prune when the tail from there fits", async () => {
      const { chooseCut } = await import("../src/contextReset.js");
      const messages = [user("start"), reply(big(100_000)), call("p1", "mcp__mekiri-proxy__prune"), result("p1"), reply("done"), user("next")];
      expect(chooseCut(messages, new Set(), 0, settings)).toEqual({ cut: 2, afterLastPrune: true });
    });

    it("falls back to the last K turns, never starting the tail at a tool_result", async () => {
      const { chooseCut } = await import("../src/contextReset.js");
      const turn = (i: number) => [user(`p${i}`), call(`t${i}`), result(`t${i}`), reply(`r${i}`)];
      const messages = [...turn(0), ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
      expect(chooseCut(messages, new Set(), 0, settings)).toEqual({ cut: 8, afterLastPrune: false });
    });

    it("shortens the K turns from the front to the token cap, skipping tool_result messages", async () => {
      const { chooseCut } = await import("../src/contextReset.js");
      const messages = [user("p0"), call("a"), result("a", big(64_000)), reply("r0"), user("p1"), call("b"), result("b", big(19_200)), reply("r1")];
      // From index 1 the tail is ~26k tokens, from 3 ~6k. With a 5k cap only
      // the closing reply fits: index 6 (a tool_result) is never a start.
      expect(chooseCut(messages, new Set(), 0, settings)).toEqual({ cut: 3, afterLastPrune: false });
      expect(chooseCut(messages, new Set(), 0, { tailTokens: 5000, tailTurns: 4 })).toEqual({ cut: 7, afterLastPrune: false });
    });

    it("keeps just the last tool call when one giant tool result doesn't fit at all", async () => {
      const { chooseCut } = await import("../src/contextReset.js");
      const messages = [user("p0"), reply("r0"), user("p1"), call("a"), result("a", big(500_000))];
      expect(chooseCut(messages, new Set(), 0, settings)).toEqual({ cut: 3, afterLastPrune: false });
    });

    it("only moves forward past the current reset boundary", async () => {
      const { chooseCut } = await import("../src/contextReset.js");
      const messages = [user("p0"), reply("r0"), user("p1"), reply("r1")];
      expect(chooseCut(messages, new Set(), 3, settings)).toBeNull();
      expect(chooseCut(messages, new Set(), 1, settings)?.cut).toBe(2);
    });
  });

  describe("applyReset", () => {
    it("injects reminders, instruction and the out-of-tail last prompt, byte-stable across cache_control moves", async () => {
      const { applyReset, normalizedHash } = await import("../src/contextReset.js");
      const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } };
      const first = { role: "user", content: [reminder, { type: "text", text: "old topic" }] };
      const lastPrompt = { role: "user", content: [{ type: "text", text: "fix all 7 bugs" }, image] };
      const messages = [first, reply("r0"), lastPrompt, call("a"), result("a"), call("b"), result("b")];
      const rule = {
        id: "r",
        kind: "reset" as const,
        keepFromHash: normalizedHash(messages[5]),
        lastPromptHash: normalizedHash(lastPrompt),
        instruction: "[Mekiri context reset] warm up",
        createdAt: "t",
      };

      const out = applyReset(messages, new Set(), rule);
      expect(out).toEqual([
        {
          role: "user",
          content: [
            reminder,
            { type: "text", text: "[Mekiri context reset] warm up" },
            { type: "text", text: "[Mekiri] The last user prompt before the reset, verbatim:" },
            { type: "text", text: "fix all 7 bugs" },
            image,
          ],
        },
        messages[5],
        messages[6],
      ]);

      const moved = messages.map((m, i) =>
        i === 5 ? { role: "assistant", content: [{ ...(m.content as object[])[0], cache_control: { type: "ephemeral" } }] } : m,
      );
      expect(JSON.stringify(applyReset(moved, new Set(), rule)[0])).toBe(JSON.stringify(out[0]));
    });

    it("merges the injection into a tail that starts with a user message, and skips a prompt inside the tail", async () => {
      const { applyReset, normalizedHash } = await import("../src/contextReset.js");
      const messages = [user("p0"), reply("r0"), user("p1"), reply("r1")];
      const rule = { id: "r", kind: "reset" as const, keepFromHash: normalizedHash(messages[2]), lastPromptHash: normalizedHash(messages[2]), instruction: "I", createdAt: "t" };
      expect(applyReset(messages, new Set(), rule)).toEqual([
        { role: "user", content: [{ type: "text", text: "I" }, { type: "text", text: "p1" }] },
        messages[3],
      ]);
    });

    it("keeps its tail anchored when an identical message repeats later", async () => {
      const { createResetRule, applyReset } = await import("../src/contextReset.js");
      const stop = () => user("Stop hook feedback: call prune");
      const messages = [user("p0"), reply(big(40_000)), stop(), reply("r1"), user("p2"), reply("r2")];
      const rule = await createResetRule({ sessionId: "s", messages, excluded: new Set(), resetRules: [], settings: { ...settings, tailTurns: 2 }, estimate: 1000 });
      expect(rule?.keepFromOccurrence).toBe(0);
      const later = [...messages, stop(), reply("r3")];
      // The tail still starts at the first Stop-hook message, not the newer copy.
      expect(applyReset(later, new Set(), rule!).slice(1)).toEqual(later.slice(3));
    });

    it("composes with prune cuts through rewriteMessages, the latest reset winning", async () => {
      const { normalizedHash } = await import("../src/contextReset.js");
      const { rewriteMessages } = await import("../src/rewriteMessages.js");
      const messages = [
        user("p0"),
        reply("old stuff"),
        user("p1"),
        reply("start of pruned episode"),
        call("p", "mcp__mekiri-proxy__prune"),
        { role: "user", content: [{ type: "tool_result", tool_use_id: "p", content: '{"rule_id":"cut-1"}' }] },
        reply("after"),
        user("p2"),
      ];
      const reset = (idx: number, id: string) => ({ id, kind: "reset" as const, keepFromHash: normalizedHash(messages[idx]), instruction: id, createdAt: "t" });
      const out = rewriteMessages(messages, [reset(2, "first"), { id: "cut-1", matchQuote: "start of pruned" }, reset(3, "second")]);
      expect(out).toEqual([
        { role: "user", content: [{ type: "text", text: "second" }] },
        messages[4],
        messages[5],
        messages[6],
        messages[7],
      ]);
    });
  });

  describe("createResetRule", () => {
    it("records the unarchived stretch as [auto-reset] and puts the capsule into the instruction", async () => {
      const { createResetRule } = await import("../src/contextReset.js");
      const { appendNewShadowMessages } = await import("../src/shadowTranscript.js");
      const turn = (i: number, out = "ok") => [user(`p${i}`), call(`t${i}`), result(`t${i}`, out), reply(`r${i}`)];
      const messages = [...turn(0, big(40_000)), ...turn(1), ...turn(2), ...turn(3), ...turn(4)];
      await appendNewShadowMessages("s", messages);

      const rule = await createResetRule({
        sessionId: "s",
        dir: projectDir,
        messages,
        excluded: new Set(),
        resetRules: [],
        settings,
        estimate: 150_000,
      });
      expect(rule?.kind).toBe("reset");
      expect(rule?.lastPromptHash).toBeUndefined(); // p4 is inside the tail

      const capsule = readFileSync(path.join(projectDir, ".mekiri", "sessions", "s", "capsule.md"), "utf8");
      expect(capsule).toContain("[auto-reset] context reset at ~150k tokens; 3 unarchived messages dropped");
      expect(capsule).toContain(rule!.id);
      const entry = JSON.parse(readFileSync(path.join(projectDir, ".mekiri", "capsule-index.jsonl"), "utf8").trim());
      expect(entry).toMatchObject({ event: "auto-reset", ruleId: rule!.id, rawStartLine: 1, rawEndLine: 4, rawSource: "shadow" });
      expect(entry.activityLog).toContain("Bash");
      expect(rule!.instruction).toContain("mekiri-warmup");
      expect(rule!.instruction).toContain(`graft("${rule!.id}")`);
      expect(rule!.instruction).toContain("This session's capsule.md:\n«[auto-reset]");
    });

    it("counts only what this reset drops, not the prefix an earlier reset took", async () => {
      const { createResetRule, normalizedHash } = await import("../src/contextReset.js");
      const { appendNewShadowMessages } = await import("../src/shadowTranscript.js");
      const turn = (i: number, out = "ok") => [user(`p${i}`), call(`t${i}`), result(`t${i}`, out), reply(`r${i}`)];
      const messages = [...turn(0), ...turn(1), ...turn(2, big(40_000)), ...turn(3), ...turn(4), ...turn(5)];
      await appendNewShadowMessages("s", messages);
      const earlier = { id: "e", kind: "reset" as const, keepFromHash: normalizedHash(messages[8]), instruction: "e", createdAt: "t" };
      const rule = await createResetRule({ sessionId: "s", dir: projectDir, messages, excluded: new Set(), resetRules: [earlier], settings: { ...settings, tailTurns: 2 }, estimate: 150_000 });
      expect(rule).not.toBeNull();
      const capsule = readFileSync(path.join(projectDir, ".mekiri", "sessions", "s", "capsule.md"), "utf8");
      // Tail = last 2 turns (index 16 on); this reset drops indices 8..15.
      expect(capsule).toContain("; 8 unarchived messages dropped");
    });

    it("declines a reset that would free little room, so it can't fire on every request", async () => {
      const { createResetRule } = await import("../src/contextReset.js");
      const turn = (i: number) => [user(`p${i}`), reply(`r${i}`)];
      const messages = [...turn(0), ...turn(1), user("p2"), call("a"), result("a", big(60_000))];
      expect(await createResetRule({ sessionId: "s", messages, excluded: new Set(), resetRules: [], settings, estimate: 1000 })).toBeNull();
    });

    it("writes no record when the tail starts at the last prune, and none without a project dir", async () => {
      const { createResetRule } = await import("../src/contextReset.js");
      const withPrune = [user("p0"), reply(big(100_000)), call("p", "mcp__mekiri-proxy__prune"), result("p"), user("p1")];
      const rule = await createResetRule({ sessionId: "s", dir: projectDir, messages: withPrune, excluded: new Set(), resetRules: [], settings, estimate: 1000 });
      expect(rule?.lastPromptHash).toBeUndefined();
      expect(() => readFileSync(path.join(projectDir, ".mekiri", "capsule-index.jsonl"))).toThrow();

      const noDir = await createResetRule({ sessionId: "s", messages: [user("p0"), reply("r0"), user("p1"), reply("r1"), user("p2")], excluded: new Set(), resetRules: [], settings: { ...settings, tailTurns: 1 }, estimate: 1000 });
      expect(noDir?.instruction).toContain("no library entries yet");
    });
  });
});
