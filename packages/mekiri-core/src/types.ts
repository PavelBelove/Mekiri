export type NoteType = "portal" | "death_reload";
export type BranchType = "prune" | "sprout";

export interface FileTouched {
  path: string;
  change: string;
}

export interface PortalFruit {
  summary: string;
  files_touched?: FileTouched[];
  gotchas?: string;
  /** Important context that stays live (not cut) but is worth archiving for
   *  future sessions -- the former `tag` payload, now riding along on every
   *  `prune` call. Always present, "" when nothing is worth flagging. */
  kept_context: string;
}

export interface DeathReloadFruit {
  tried: string;
  ruled_out: string;
  facts_learned?: string;
  trigger?: "self_detected" | "user_feedback";
  /** See PortalFruit.kept_context. */
  kept_context: string;
}

export type Fruit = PortalFruit | DeathReloadFruit;

/**
 * One line of a Claude Code session transcript, in the subset of fields
 * mekiri-core cares about. `[key: string]: unknown` preserves every other
 * field so a RawLine can round-trip through JSON.stringify without loss.
 */
export interface RawLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: unknown;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }> | string;
  };
  [key: string]: unknown;
}

export type BoundaryResult =
  | { status: "ok"; messageId: string }
  | { status: "not_found" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "in_compacted_zone"; lastCompactMessageId: string };

/** One entry in `.mekiri/capsule-index.jsonl` -- the machine-readable index
 *  `graft` uses to look up a report.md line range by `ruleId`. Mirrors one
 *  line of the human-readable `.mekiri/capsule.md`. */
export interface CapsuleIndexEntry {
  ruleId: string;
  header: string;
  startLine: number;
  endLine: number;
  event: "prune";
  /** Which halves of the merged `prune` call actually fired: "kept" (the
   *  archive-only, former `tag` half -- nothing removed from live context)
   *  and/or "cut" (context actually removed and replaced by a distillate). */
  parts: ("kept" | "cut")[];
  sessionId: string;
  timestamp: string;
  /** 1-based indices into the RawLine[] returned by `readSessionTranscript`
   *  for this sessionId -- the raw transcript fragment `graft` can replay
   *  verbatim. Chained per-session: rawStartLine is the previous entry's
   *  rawEndLine + 1 (or 1 if this is the session's first entry). Absent on
   *  entries written before this field existed -- graft must fall back
   *  gracefully, never crash, on old capsule-index.jsonl data. */
  rawStartLine?: number;
  rawEndLine?: number;
}
