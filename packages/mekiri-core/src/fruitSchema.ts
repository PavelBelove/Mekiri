import { z } from "zod";
import type { NoteType, PortalFruit, DeathReloadFruit } from "./types.js";

const FileTouchedSchema = z.object({
  path: z.string(),
  change: z.string(),
});

const PortalFruitSchema = z.object({
  summary: z.string(),
  files_touched: z.array(FileTouchedSchema).optional(),
  gotchas: z.string().optional(),
  kept_context: z.string(),
  conclusion: z.string(),
});

const DeathReloadFruitSchema = z.object({
  tried: z.string(),
  ruled_out: z.string(),
  facts_learned: z.string().optional(),
  trigger: z.enum(["self_detected", "user_feedback"]).optional(),
  kept_context: z.string(),
  conclusion: z.string(),
});

export interface ValidateFruitArgs {
  noteType: NoteType;
  fruit: unknown;
  keepCode: boolean;
  quote: string;
}

export type ValidateFruitResult =
  | { ok: true; fruit: PortalFruit | DeathReloadFruit }
  | { ok: false; errors: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? path + ": " + issue.message : issue.message;
  });
}

export function validateFruit(args: ValidateFruitArgs): ValidateFruitResult {
  const hasCut = args.quote !== "";

  if (!hasCut && args.noteType === "death_reload") {
    return {
      ok: false,
      errors: [
        "note_type: death_reload requires a non-empty quote (an abandoned hypothesis always cuts something); " +
          "for a pure archive note with nothing to cut, use note_type: portal",
      ],
    };
  }

  if (args.noteType === "portal") {
    const parsed = PortalFruitSchema.safeParse(args.fruit);
    if (!parsed.success) {
      return { ok: false, errors: formatIssues(parsed.error) };
    }
    if (parsed.data.conclusion.trim() === "") {
      return { ok: false, errors: ["conclusion: is required (non-empty)"] };
    }
    if (hasCut) {
      if (parsed.data.summary.trim() === "") {
        return { ok: false, errors: ["summary: is required (non-empty) when quote is non-empty"] };
      }
      if (args.keepCode && !parsed.data.files_touched) {
        return { ok: false, errors: ["files_touched is required when keep_code is true"] };
      }
    } else if (parsed.data.kept_context.trim() === "") {
      return {
        ok: false,
        errors: [
          "nothing to record: quote is empty (nothing to cut) and kept_context is empty (nothing to keep) -- " +
            "fill in at least one of the two",
        ],
      };
    }
    return { ok: true, fruit: parsed.data };
  }

  const parsed = DeathReloadFruitSchema.safeParse(args.fruit);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  if (parsed.data.conclusion.trim() === "") {
    return { ok: false, errors: ["conclusion: is required (non-empty)"] };
  }
  if (parsed.data.tried.trim() === "" || parsed.data.ruled_out.trim() === "") {
    return { ok: false, errors: ["tried and ruled_out are required (non-empty) for death_reload"] };
  }
  return { ok: true, fruit: parsed.data };
}
