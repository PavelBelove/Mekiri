import { describe, it, expect, beforeEach } from "vitest";
import { findLastCompactBoundaryIndex } from "../src/compactZone.js";
import { resetUuidCounter, userLine, assistantLine, compactPair } from "./helpers/buildTranscript.js";
import type { RawLine } from "../src/types.js";

describe("findLastCompactBoundaryIndex", () => {
  beforeEach(() => {
    resetUuidCounter();
  });

  it("returns -1 when there is no compact event", () => {
    const u1 = userLine(null, "hello");
    const a1 = assistantLine(u1.uuid!, "hi there");
    expect(findLastCompactBoundaryIndex([u1, a1])).toBe(-1);
  });

  it("returns the index of the compact summary line when there is one", () => {
    const u1 = userLine(null, "hello");
    const a1 = assistantLine(u1.uuid!, "working on it");
    const { system, summary } = compactPair(a1.uuid!);
    const a2 = assistantLine(summary.uuid!, "continuing after compact");
    const lines: RawLine[] = [u1, a1, system, summary, a2];
    expect(findLastCompactBoundaryIndex(lines)).toBe(3);
  });

  it("returns the index of the LAST compact summary when there are two", () => {
    const u1 = userLine(null, "hello");
    const first = compactPair(u1.uuid!);
    const a1 = assistantLine(first.summary.uuid!, "between compacts");
    const second = compactPair(a1.uuid!);
    const a2 = assistantLine(second.summary.uuid!, "after second compact");
    const lines: RawLine[] = [u1, first.system, first.summary, a1, second.system, second.summary, a2];
    expect(findLastCompactBoundaryIndex(lines)).toBe(5);
  });
});
