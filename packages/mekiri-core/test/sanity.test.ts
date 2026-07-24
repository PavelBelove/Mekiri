import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package sanity", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-core");
  });
});
