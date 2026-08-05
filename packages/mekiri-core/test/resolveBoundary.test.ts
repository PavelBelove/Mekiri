import { describe, it, expect, beforeEach } from "vitest";
import { resolveBoundaryWithRetry } from "../src/resolveBoundary.js";
import { resetUuidCounter, userLine, assistantLine } from "./helpers/buildTranscript.js";
import type { RawLine } from "../src/types.js";

describe("resolveBoundaryWithRetry", () => {
  beforeEach(() => {
    resetUuidCounter();
  });

  it("resolves immediately without retrying when the quote is already present", async () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "Unique phrase already on disk.");
    const lines: RawLine[] = [u1, a1];

    let calls = 0;
    const readTranscript = async () => {
      calls += 1;
      return lines;
    };

    const { boundary } = await resolveBoundaryWithRetry(readTranscript, "Unique phrase already on disk", {
      retries: 5,
      delayMs: 1,
    });

    expect(boundary).toEqual({ status: "ok", messageId: a1.uuid });
    expect(calls).toBe(1);
  });

  it("retries against a fresh read until the quote shows up (simulating transcript write lag)", async () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "Nothing interesting yet.");
    const before: RawLine[] = [u1, a1];

    const a2 = assistantLine(a1.uuid!, "Line that appears only after the disk write catches up.");
    const after: RawLine[] = [...before, a2];

    let calls = 0;
    const readTranscript = async () => {
      calls += 1;
      return calls < 3 ? before : after;
    };

    const { boundary } = await resolveBoundaryWithRetry(
      readTranscript,
      "Line that appears only after the disk write catches up",
      { retries: 5, delayMs: 1 },
    );

    expect(boundary).toEqual({ status: "ok", messageId: a2.uuid });
    expect(calls).toBe(3);
  });

  it("gives up and returns not_found once retries are exhausted", async () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "This quote never appears anywhere.");
    const lines: RawLine[] = [u1, a1];

    let calls = 0;
    const readTranscript = async () => {
      calls += 1;
      return lines;
    };

    const { boundary } = await resolveBoundaryWithRetry(readTranscript, "text that truly does not exist", {
      retries: 3,
      delayMs: 1,
    });

    expect(boundary).toEqual({ status: "not_found" });
    expect(calls).toBe(4); // initial attempt + 3 retries
  });

  it("returns ambiguous immediately on the first read without retrying", async () => {
    const u1 = userLine(null, "investigate");
    const a1 = assistantLine(u1.uuid!, "Checking the database schema for issues.");
    const a2 = assistantLine(a1.uuid!, "Checking the database schema for issues, again.");
    const lines: RawLine[] = [u1, a1, a2];

    let calls = 0;
    const readTranscript = async () => {
      calls += 1;
      return lines;
    };

    const { boundary } = await resolveBoundaryWithRetry(readTranscript, "Checking the database schema for issues", {
      retries: 5,
      delayMs: 1,
    });

    expect(boundary).toEqual({ status: "ambiguous", occurrences: 2 });
    expect(calls).toBe(1);
  });
});
