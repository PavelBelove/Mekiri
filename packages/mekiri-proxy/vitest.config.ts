import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.MEKIRI_PROXY_LIVE_TEST ? undefined : ["**/*.smoke.test.ts"],
  },
});
