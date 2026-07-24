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
    expect(result).toEqual({ status: "ok", uuid: a1.uuid });
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

  it("returns in_compacted_zone when the quote only exists before the last compact boundary", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "This sentence lives before the compaction event.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "This is fresh work after the compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "This sentence lives before the compaction");
    expect(result).toEqual({ status: "in_compacted_zone", lastCompactUuid: summary.uuid });
  });

  it("only searches after the last compact boundary when one exists", () => {
    const u1 = userLine(null, "start");
    const a1 = assistantLine(u1.uuid!, "Shared phrase appears here too, before compaction.");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "Shared phrase appears here too, after compaction.");
    const lines: RawLine[] = [u1, a1, system, summary, a2];

    const result = findBoundary(lines, "Shared phrase appears here too");
    expect(result).toEqual({ status: "ok", uuid: a2.uuid });
  });
});
