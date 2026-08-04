import { promises as fs } from "node:fs";
import path from "node:path";
import { MekiriConfigSchema, defaultConfig, type MekiriConfig } from "./configSchema.js";

const CONFIG_RELATIVE_PATH = path.join(".mekiri", "config.json");

export async function loadConfig(projectDir: string): Promise<MekiriConfig> {
  const filePath = path.join(projectDir, CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    // A missing config file is the normal, silent case (project hasn't been
    // configured yet) -- fall back to defaults with no diagnostic. Any other
    // read failure (permissions, etc.) is unexpected and worth surfacing,
    // even though we still degrade to defaults rather than crashing the
    // caller (mekiri-host/mekiri-proxy read config on every tool call).
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`mekiri: failed to read config at ${filePath}, falling back to defaults:`, err);
    }
    return defaultConfig();
  }

  // Below this point the file exists but its *content* is bad (malformed
  // JSON, or JSON that doesn't match the schema -- e.g. hand-edited by a
  // user/agent). Previously both cases were swallowed identically to the
  // missing-file case above (bare `catch { return defaultConfig() }`),
  // silently discarding whatever the user actually had on disk with no
  // signal at all that their config was ignored. Surface a diagnostic while
  // still degrading gracefully to defaults, so a corrupted config.json is
  // observable instead of silently invisible.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`mekiri: config at ${filePath} is not valid JSON, falling back to defaults:`, err);
    return defaultConfig();
  }

  const parsed = MekiriConfigSchema.safeParse(json);
  if (!parsed.success) {
    console.error(
      `mekiri: config at ${filePath} failed validation, falling back to defaults:`,
      parsed.error.issues,
    );
    return defaultConfig();
  }
  return parsed.data;
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
