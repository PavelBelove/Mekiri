export const PACKAGE_NAME = "mekiri-core";

export type {
  NoteType,
  BranchType,
  FileTouched,
  PortalFruit,
  DeathReloadFruit,
  Fruit,
  RawLine,
  BoundaryResult,
} from "./types.js";
export { validateFruit } from "./fruitSchema.js";
export type { ValidateFruitArgs, ValidateFruitResult } from "./fruitSchema.js";
export { findLastCompactBoundaryIndex } from "./compactZone.js";
export { findBoundary } from "./quoteMatcher.js";
export { MekiriConfigSchema, defaultConfig } from "./configSchema.js";
export type { MekiriConfig } from "./configSchema.js";
export { loadConfig, saveConfig, applyConfigPatch } from "./configStore.js";
export type { ConfigPatchResult } from "./configStore.js";
