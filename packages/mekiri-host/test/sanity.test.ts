import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package sanity", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-host");
  });

  it("can import mekiri-core's public API", async () => {
    const core = await import("mekiri-core");
    expect(typeof core.findBoundary).toBe("function");
    expect(typeof core.createBranch).toBe("function");
    expect(typeof core.validateFruit).toBe("function");
  });
});
