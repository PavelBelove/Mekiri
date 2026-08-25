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
 * closes exactly one gap: a *previous, already-ended* turn's text that
 * hasn't finished flushing to the .jsonl transcript yet by the time this
 * call fires early in the next turn -- a bounded race, fixed by retrying.
 *
 * It does NOT and cannot make a quote from the *current, still-generating*
 * turn valid: that text has no on-disk representation at all until this
 * turn ends and control returns to the caller, so no retry budget will ever
 * see it -- retrying more is not the fix for that case (see mekiri-gate
 * SKILL.md's "quote boundary" section and bin/mcp-server.ts's `quote`
 * description for the checkable rule: valid only from a turn that has
 * already ended and returned control to the user). Only "not_found" is
 * retried; "ambiguous" and "in_compacted_zone" are real, immediate answers.
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
