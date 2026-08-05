import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, applyConfigPatch } from "../src/configStore.js";
import { defaultConfig } from "../src/configSchema.js";

describe("config store", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-config-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig(projectDir);
    expect(config).toEqual(defaultConfig());
  });

  it("round-trips a saved config", async () => {
    const config = { ...defaultConfig(), sprout: { depth_limit: 2, wait_mode: "sync" as const } };
    await saveConfig(projectDir, config);
    const loaded = await loadConfig(projectDir);
    expect(loaded).toEqual(config);
  });

  it("applyConfigPatch deep-merges and validates", () => {
    const result = applyConfigPatch(defaultConfig(), { sprout: { depth_limit: 5 } });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config.sprout.depth_limit).toBe(5);
      expect(result.config.priorities.token_efficiency).toBe("balanced");
    }
  });

  it("applyConfigPatch rejects an invalid patch", () => {
    const result = applyConfigPatch(defaultConfig(), { priorities: { token_efficiency: "yolo" } });
    expect(result.status).toBe("invalid");
  });

  it("falls back to defaults (silently) when no config file exists", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = await loadConfig(projectDir);
    expect(config).toEqual(defaultConfig());
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("falls back to defaults but surfaces a diagnostic for malformed JSON", async () => {
    const filePath = path.join(projectDir, ".mekiri", "config.json");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ not valid json", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = await loadConfig(projectDir);

    expect(config).toEqual(defaultConfig());
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("not valid JSON");
    errorSpy.mockRestore();
  });

  it("falls back to defaults but surfaces a diagnostic for schema-invalid JSON", async () => {
    const filePath = path.join(projectDir, ".mekiri", "config.json");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ sprout: { wait_mode: "eventually" } }), "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = await loadConfig(projectDir);

    expect(config).toEqual(defaultConfig());
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("failed validation");
    errorSpy.mockRestore();
  });
});
