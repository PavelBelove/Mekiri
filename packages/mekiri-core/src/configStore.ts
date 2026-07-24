import { promises as fs } from "node:fs";
import path from "node:path";
import { MekiriConfigSchema, defaultConfig, type MekiriConfig } from "./configSchema.js";

const CONFIG_RELATIVE_PATH = path.join(".mekiri", "config.json");

export async function loadConfig(projectDir: string): Promise<MekiriConfig> {
  const filePath = path.join(projectDir, CONFIG_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = MekiriConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(projectDir: string, config: MekiriConfig): Promise<void> {
  const filePath = path.join(projectDir, CONFIG_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export type ConfigPatchResult =
  | { status: "ok"; config: MekiriConfig }
  | { status: "invalid"; errors: string[] };

export function applyConfigPatch(current: MekiriConfig, patch: unknown): ConfigPatchResult {
  const merged = deepMerge(current as Record<string, unknown>, patch as Record<string, unknown>);
  const parsed = MekiriConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return { status: "invalid", errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { status: "ok", config: parsed.data };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  const baseIsObject = typeof base === "object" && base !== null && !Array.isArray(base);
  const patchIsObject = typeof patch === "object" && patch !== null && !Array.isArray(patch);

  if (baseIsObject && patchIsObject) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      result[key] = deepMerge((base as Record<string, unknown>)[key], value);
    }
    return result;
  }
  return patch === undefined ? base : patch;
}
