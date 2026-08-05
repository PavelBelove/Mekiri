import { z } from "zod";

const SproutSchema = z.object({
  depth_limit: z.number().int().min(0).default(1),
  wait_mode: z.enum(["sync", "async"]).default("sync"),
});

const PrioritiesSchema = z.object({
  token_efficiency: z.enum(["aggressive", "balanced", "irrelevant"]).default("balanced"),
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
});

export type MekiriConfig = z.infer<typeof MekiriConfigSchema>;

export function defaultConfig(): MekiriConfig {
  return MekiriConfigSchema.parse({});
}
