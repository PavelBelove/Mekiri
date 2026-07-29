import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RewriteRule } from "./rewriteMessages.js";

export interface StoredRuleEntry {
  dir: string;
  rule: RewriteRule;
  updatedAt: string;
}

// A single, machine-global rules file — the daemon is one shared process
// serving every project on the machine (see design spec §1), so per-project
// `.mekiri/proxy-rules.json` would require resolving which project a
// sessionId belongs to before the daemon even knows where to look on
// restart. Keying everything by sessionId in one place avoids that
// resolution step entirely. Overridable for tests.
export function resolveStateDir(): string {
  return process.env.MEKIRI_PROXY_STATE_DIR || path.join(homedir(), ".mekiri-proxy");
}

function rulesFilePath(): string {
  return path.join(resolveStateDir(), "rules.json");
}

export async function loadAllRules(): Promise<Record<string, StoredRuleEntry>> {
  try {
    const raw = await fs.readFile(rulesFilePath(), "utf8");
    return JSON.parse(raw) as Record<string, StoredRuleEntry>;
  } catch {
    return {};
  }
}

export async function saveRule(sessionId: string, dir: string, rule: RewriteRule): Promise<void> {
  const all = await loadAllRules();
  all[sessionId] = { dir, rule, updatedAt: new Date().toISOString() };
  await fs.mkdir(resolveStateDir(), { recursive: true });
  await fs.writeFile(rulesFilePath(), JSON.stringify(all, null, 2), "utf8");
}
