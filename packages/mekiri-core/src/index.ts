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
