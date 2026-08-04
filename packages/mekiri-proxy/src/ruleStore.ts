import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RewriteRule } from "./rewriteMessages.js";

export interface StoredRuleEntry {
  dir: string;
  rules: RewriteRule[];
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

// Defensive per-entry: an old-format entry (pre-cumulative-rules, keyed by
// `.rule` instead of `.rules`) must not crash the daemon on startup -- this
// file is dev-only, session-lifetime state, so there's no migration, just
// graceful degradation to an empty rule list for that one session.
export async function loadAllRules(): Promise<Record<string, StoredRuleEntry>> {
  try {
    const raw = await fs.readFile(rulesFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, Partial<StoredRuleEntry>>;
    const result: Record<string, StoredRuleEntry> = {};
    for (const [sessionId, entry] of Object.entries(parsed)) {
      result[sessionId] = {
        dir: entry.dir ?? "",
        rules: Array.isArray(entry.rules) ? entry.rules : [],
        updatedAt: entry.updatedAt ?? new Date(0).toISOString(),
      };
    }
    return result;
  } catch {
    return {};
  }
}

export async function appendRule(sessionId: string, dir: string, rule: RewriteRule): Promise<void> {
  const all = await loadAllRules();
  const existing = all[sessionId]?.rules ?? [];
  all[sessionId] = { dir, rules: [...existing, rule], updatedAt: new Date().toISOString() };
  await fs.mkdir(resolveStateDir(), { recursive: true });
  await fs.writeFile(rulesFilePath(), JSON.stringify(all, null, 2), "utf8");
}
