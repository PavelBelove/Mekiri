import { describe, it, expect } from "vitest";
import { validateFruit } from "../src/fruitSchema.js";

describe("validateFruit", () => {
  it("accepts a portal fruit without files_touched when keep_code is false", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause", kept_context: "", conclusion: "found the root cause in the logs" },
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing files_touched when keep_code is true", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause", kept_context: "", conclusion: "found the root cause in the logs" },
      keepCode: true,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/files_touched/);
    }
  });

  it("accepts a portal fruit with files_touched when keep_code is true", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {
        summary: "read logs, found the cause",
        files_touched: [{ path: "src/foo.ts", change: "fixed off-by-one" }],
        kept_context: "",
        conclusion: "found the root cause in the logs",
      },
      keepCode: true,
      quote: "some quote",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing summary and kept_context entirely", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {},
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
  });

  it("prefixes the field path onto the Zod validation error instead of a bare message", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {},
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^summary: /);
    }
  });

  it("rejects a portal fruit missing conclusion", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause", kept_context: "" },
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a portal fruit with an empty conclusion", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause", kept_context: "", conclusion: "" },
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/conclusion/);
    }
  });

  it("accepts a death_reload fruit with tried and ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug", ruled_out: "it is not serialization", kept_context: "", conclusion: "serialization ruled out as the cause" },
      keepCode: true,
      quote: "some quote",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a death_reload fruit missing ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug", kept_context: "", conclusion: "serialization ruled out as the cause" },
      keepCode: true,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects death_reload when quote is empty (a dead end always cuts something)", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "x", ruled_out: "y", kept_context: "", conclusion: "x ruled out" },
      keepCode: true,
      quote: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/death_reload/);
    }
  });

  it("rejects a death_reload fruit with an empty conclusion", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "x", ruled_out: "y", kept_context: "", conclusion: "" },
      keepCode: true,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/conclusion/);
    }
  });

  it("accepts a pure archive call: quote empty, kept_context non-empty, cut side left blank", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "", kept_context: "an invariant worth remembering", conclusion: "invariant worth remembering" },
      keepCode: false,
      quote: "",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when both quote and kept_context are empty (nothing to cut, nothing to keep)", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "", kept_context: "", conclusion: "nothing to record" },
      keepCode: false,
      quote: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/nothing to record/);
    }
  });

  it("rejects a cut portal call with an empty summary", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "", kept_context: "", conclusion: "nothing to record" },
      keepCode: false,
      quote: "some quote",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/summary/);
    }
  });
});
