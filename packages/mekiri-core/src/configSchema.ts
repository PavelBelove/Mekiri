import { z } from "zod";

const SproutSchema = z.object({
  depth_limit: z.number().int().min(0).default(1),
  wait_mode: z.enum(["sync", "async"]).default("sync"),
});

const PrioritiesSchema = z.object({
  token_efficiency: z.enum(["aggressive", "balanced", "irrelevant"]).default("balanced"),
});

// One-shot, auditable grace period for the PostToolUse nudge-hook: an agent
// mid-verification (e.g. it just wrote a file and now needs a test/build call
// before it can honestly close the episode) sets this via
// `configure_mekiri({patch:{nudge:{deferCalls: N}}}})` to suspend nudge/hard-block
// counting for N subsequent tool calls. bin/nudge-hook.ts resets it back to 0
// on disk once consumed, so a grant is always single-use, not an ambient
// setting -- see decideNudge's deferCallsFromConfig param in nudgeHook.ts.
const NudgeSchema = z.object({
  deferCalls: z.number().int().min(0).max(20).default(0),
});

// Kill-switch for the Stop-hook-forced-prune mechanism (see
// bin/stop-hook.ts / src/stopHook.ts). Defaults to false so merging the
// feature branch into main never silently activates it -- enabling
// requires an explicit `configure_mekiri({patch:{stopHook:{enabled:true}}}})`
// on top of also wiring bin/stop-hook.ts into .claude/settings.json (two
// independent switches, both required).
const StopHookSchema = z.object({
  enabled: z.boolean().default(false),
});

// Mekiri's replacement for Claude Code's auto-compaction (see
// docs/mechanics/context-reset.md): near the limit, mekiri-proxy drops the
// middle of the conversation, keeps the tail and has the agent warm up from
// the library. Off by default for the same reason as stopHook: the proxy
// daemon is shared by every project on the machine. thresholdTokens 0 means
// "auto": just below where Claude Code's own auto-compaction would fire.
const ContextResetSchema = z.object({
  enabled: z.boolean().default(false),
  thresholdTokens: z.number().int().min(0).default(0),
  tailTokens: z.number().int().min(1000).default(20000),
  tailTurns: z.number().int().min(1).default(4),
});

export const MekiriConfigSchema = z.object({
  // The outer default is *derived* by re-parsing {} through the same inner
  // schema, rather than a hand-written literal — zod v4's .default() does
  // not itself cascade an inner schema's per-field defaults when the outer
  // key is entirely absent (verified empirically against zod 4.4.3), so a
  // static/literal outer default would silently drift from the per-field
  // defaults above it. Deriving it this way keeps exactly one source of
  // truth for every default value.
  sprout: SproutSchema.default(() => SproutSchema.parse({})),
  priorities: PrioritiesSchema.default(() => PrioritiesSchema.parse({})),
  nudge: NudgeSchema.default(() => NudgeSchema.parse({})),
  stopHook: StopHookSchema.default(() => StopHookSchema.parse({})),
  contextReset: ContextResetSchema.default(() => ContextResetSchema.parse({})),
});

export type MekiriConfig = z.infer<typeof MekiriConfigSchema>;

export function defaultConfig(): MekiriConfig {
  return MekiriConfigSchema.parse({});
}
