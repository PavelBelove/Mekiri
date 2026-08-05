import { describe, it, expect } from "vitest";
import { MekiriConfigSchema, defaultConfig } from "../src/configSchema.js";

describe("MekiriConfigSchema", () => {
  it("produces the documented Phase 1 defaults from an empty object", () => {
    const config = defaultConfig();
    expect(config).toEqual({
      sprout: {
        depth_limit: 1,
        wait_mode: "sync",
      },
      priorities: {
        token_efficiency: "balanced",
      },
    });
  });

  it("accepts a partial override merged onto defaults via parse", () => {
    const config = MekiriConfigSchema.parse({ sprout: { depth_limit: 3 } });
    expect(config.sprout.depth_limit).toBe(3);
    expect(config.sprout.wait_mode).toBe("sync");
  });

  it("rejects an invalid wait_mode", () => {
    const result = MekiriConfigSchema.safeParse({ sprout: { wait_mode: "eventually" } });
    expect(result.success).toBe(false);
  });
});
