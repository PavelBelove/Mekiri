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
 * Wraps findBoundary with retries against a fresh transcript read. Claude
 * Code writes the current turn's own text block to its on-disk .jsonl
 * transcript *after* it has already dispatched this same turn's tool_use --
 * so a quote from the turn currently being generated can spuriously read as
 * not_found on the first attempt, purely due to that write lag, indistinguishable
 * at this layer from a genuinely wrong quote. Only "not_found" is retried;
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
