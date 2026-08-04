import { describe, it, expect } from "vitest";
import { validateFruit } from "../src/fruitSchema.js";

describe("validateFruit", () => {
  it("accepts a portal fruit without files_touched when keep_code is false", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause" },
      keepCode: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing files_touched when keep_code is true", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: { summary: "read logs, found the cause" },
      keepCode: true,
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
      },
      keepCode: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a portal fruit missing summary", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {},
      keepCode: false,
    });
    expect(result.ok).toBe(false);
  });

  it("prefixes the field path onto the Zod validation error instead of a bare message", () => {
    const result = validateFruit({
      noteType: "portal",
      fruit: {},
      keepCode: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^summary: /);
    }
  });

  it("accepts a death_reload fruit with tried and ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug", ruled_out: "it's not serialization" },
      keepCode: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a death_reload fruit missing ruled_out", () => {
    const result = validateFruit({
      noteType: "death_reload",
      fruit: { tried: "assumed serialization bug" },
      keepCode: true,
    });
    expect(result.ok).toBe(false);
  });
});
