import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package scaffolding", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("mekiri-proxy");
  });
});
