import { z } from "zod";

const ParallelismSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single") }),
  z.object({ mode: z.literal("parallel"), count: z.number().int().min(1) }),
]);

export const MekiriConfigSchema = z.object({
  sprout: z
    .object({
      depth_limit: z.number().int().min(0).default(1),
      parallelism: ParallelismSchema.default({ mode: "single" }),
      wait_mode: z.enum(["sync", "async"]).default("sync"),
    })
    .optional(),
  priorities: z
    .object({
      token_efficiency: z.enum(["aggressive", "balanced", "irrelevant"]).default("balanced"),
    })
    .optional(),
});

export type MekiriConfig = z.infer<typeof MekiriConfigSchema>;

export function defaultConfig(): MekiriConfig {
  // Pass explicit empty objects to trigger per-field defaults.
  // This eliminates the duplication that previously existed in the outer .default(() => ({...})) literals.
  return MekiriConfigSchema.parse({ sprout: {}, priorities: {} });
}
