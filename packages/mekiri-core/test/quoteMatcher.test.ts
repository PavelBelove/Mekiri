import { describe, it, expect, beforeEach } from "vitest";
import { findBoundary } from "../src/quoteMatcher.js";
import {
  resetUuidCounter,
  userLine,
  assistantLine,
  assistantThinkingLine,
  compactPair,
} from "./helpers/buildTranscript.js";
import type { RawLine } from "../src/types.js";

describe("findBoundary", () => {
  beforeEach(() => {
    resetUuidCounter();
  });

  it("finds a unique quote and returns its message uuid", () => {
    const u1 = userLine(null, "fix the flaky test");
    const a1 = assistantLine(u1.uuid!, "Reading the 7000 lines of CI logs now to find the root cause.");
    const a2 = assistantLine(a1.uuid!, "Found it: a race condition in the retry loop.");
    const lines: RawLine[] = [u1, a1, a2];

    const result = findBoundary(lines, "Reading the 7000 lines of CI logs");
    expect(result).toEqual({ status: "ok", messageId: a1.uuid });
  });

  it("falls back to tool-call inputs when no text block holds the quote (text dropped between thinking blocks)", () => {
    const u1 = userLine(null, "audit the hooks");
    const a1 = assistantThinkingLine(u1.uuid!, "hmm");
    a1.message!.content = [
      { type: "thinking", text: "first" },
      { type: "thinking", text: "second" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "Compare hook state in both dirs" } },
    ];
    const result = findBoundary([u1, a1], "Compare hook state in both");
    expect(result).toEqual({ status: "ok", messageId: a1.uuid });
  });

  it("prefers a text match over a later tool-input match of the same quote", () => {
    const u1 = userLine(null, "go");
    const a1 = assistantLine(u1.uuid!, "Now writing the release notes.");
    const a2 = assistantThinkingLine(a1.uuid!, "x");
    a2.message!.content = [{ type: "tool_use", id: "t2", name: "Write", input: { content: "Now writing the release notes." } }];
    expect(findBoundary([u1, a1, a2], "Now writing the release notes")).toEqual({ status: "ok", messageId: a1.uuid });
  });

  it("never matches the quote inside a Mekiri tool call's own input", () => {
    const u1 = userLine(null, "go");
    const a1 = assistantThinkingLine(u1.uuid!, "x");
    a1.message!.content = [
      { type: "tool_use", id: "t3", name: "mcp__mekiri-proxy__prune", input: { quote: "an invented quote" } },
    ];
    expect(findBoundary([u1, a1], "an invented quote")).toEqual({ status: "not_found" });
  });

  it("returns not_found when the quote appears nowhere", () => {
    const u1 = userLine(null, "fix the flaky test");
    const a1 = assistantLine(u1.uuid!, "Looking into it.");
    const result = findBoundary([u1, a1], "this text does not appear anywhere");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns ambiguous when the quote matches two different assistant messages", () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "Checking the database schema for issues.");
    const a2 = assistantLine(a1.uuid!, "Checking the database schema for issues, again more carefully.");
    const result = findBoundary([u1, a1, a2], "Checking the database schema for issues");
    expect(result).toEqual({ status: "ambiguous", occurrences: 2 });
  });

  it("ignores sidechain assistant messages", () => {
    const u1 = userLine(null, "investigate");
    const sidechain = assistantLine(u1.uuid!, "This unique sidechain phrase should not match.", {
      isSidechain: true,
    });
    const result = findBoundary([u1, sidechain], "This unique sidechain phrase");
    expect(result).toEqual({ status: "not_found" });
  });

  it("ignores thinking blocks, only matching visible text blocks", () => {
    const u1 = userLine(null, "investigate");
    const thinking = assistantThinkingLine(u1.uuid!, "Internal reasoning phrase that should not match.");
    const result = findBoundary([u1, thinking], "Internal reasoning phrase");
    expect(result).toEqual({ status: "not_found" });
  });

  it("finds a quote in the stretch a mid-turn compaction kept verbatim, though it sits before the summary on disk", () => {
    const u1 = userLine(null, "start");
    const old = assistantLine(u1.uuid!, "Compacted away for good.");
    const kept = assistantLine(old.uuid!, "Writing the docs now, mid-turn.");
    const { summary } = compactPair(kept.uuid!);
    // Real compact_boundary lines carry the preserved uuids (Claude Code 2.1.x).
    const system: RawLine = {
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: summary.uuid, uuids: [kept.uuid], allUuids: [kept.uuid] } },
    };
    const lines: RawLine[] = [u1, old, kept, system, summary];

    expect(findBoundary(lines, "Writing the docs now")).toEqual({ status: "ok", messageId: kept.uuid });
    expect(findBoundary(lines, "Compacted away")).toEqual({ status: "in_compacted_zone", lastCompactMessageId: summary.uuid });
  });

  it("returns in_compacted_zone when the quote only exists before the last compact boundary", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "This sentence lives before the compaction event.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "This is fresh work after the compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "This sentence lives before the compaction");
    expect(result).toEqual({ status: "in_compacted_zone", lastCompactMessageId: summary.uuid });
  });

  it("only searches after the last compact boundary when one exists", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "Shared phrase appears here too, before compaction.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "Shared phrase appears here too, after compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "Shared phrase appears here too");
    expect(result).toEqual({ status: "ok", messageId: a2.uuid });
  });
});
