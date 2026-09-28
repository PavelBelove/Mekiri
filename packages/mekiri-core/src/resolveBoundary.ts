import type { BoundaryResult, RawLine } from "./types.js";
import { findBoundary } from "./quoteMatcher.js";

export interface ResolveBoundaryOptions {
  retries?: number;
  delayMs?: number;
}

export interface ResolveBoundaryResult {
  boundary: BoundaryResult;
  transcript: RawLine[];
}

const DEFAULT_RETRIES = 5;
const DEFAULT_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps findBoundary with retries against a fresh transcript read. This
 * closes exactly one gap: an *earlier, already-finished* tact (API request)
 * whose message hasn't finished flushing to the .jsonl transcript yet by the
 * time this call fires -- a bounded race, fixed by retrying.
 *
 * It does NOT and cannot make a quote from the *current* tact valid (the
 * message holding this very prune call, and any text written alongside it):
 * that message has no on-disk representation until the call returns, so no
 * retry budget will ever see it (see mekiri-gate SKILL.md's "quote boundary"
 * section and bin/mcp-server.ts's `quote` description for the checkable
 * rule: any finished tact, including earlier tacts of the current sprint, is
 * quotable; the current one is not). Only "not_found" is retried;
 * "ambiguous" and "in_compacted_zone" are real, immediate answers.
 */
export async function resolveBoundaryWithRetry(
  readTranscript: () => Promise<RawLine[]>,
  quote: string,
  options: ResolveBoundaryOptions = {},
): Promise<ResolveBoundaryResult> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  let transcript = await readTranscript();
  let boundary = findBoundary(transcript, quote);

  for (let attempt = 0; boundary.status === "not_found" && attempt < retries; attempt++) {
    await sleep(delayMs);
    transcript = await readTranscript();
    boundary = findBoundary(transcript, quote);
  }

  return { boundary, transcript };
}
