import { z } from "zod";
import type { NoteType, PortalFruit, DeathReloadFruit } from "./types.js";

const FileTouchedSchema = z.object({
  path: z.string(),
  change: z.string(),
});

const PortalFruitSchema = z.object({
  summary: z.string().min(1),
  files_touched: z.array(FileTouchedSchema).optional(),
  gotchas: z.string().optional(),
});

const DeathReloadFruitSchema = z.object({
  tried: z.string().min(1),
  ruled_out: z.string().min(1),
  facts_learned: z.string().optional(),
  trigger: z.enum(["self_detected", "user_feedback"]).optional(),
});

export interface ValidateFruitArgs {
  noteType: NoteType;
  fruit: unknown;
  keepCode: boolean;
}

export type ValidateFruitResult =
  | { ok: true; fruit: PortalFruit | DeathReloadFruit }
  | { ok: false; errors: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateFruit(args: ValidateFruitArgs): ValidateFruitResult {
  if (args.noteType === "portal") {
    const parsed = PortalFruitSchema.safeParse(args.fruit);
    if (!parsed.success) {
      return { ok: false, errors: formatIssues(parsed.error) };
    }
    if (args.keepCode && !parsed.data.files_touched) {
      return { ok: false, errors: ["files_touched is required when keep_code is true"] };
    }
    return { ok: true, fruit: parsed.data };
  }

  const parsed = DeathReloadFruitSchema.safeParse(args.fruit);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  return { ok: true, fruit: parsed.data };
}
