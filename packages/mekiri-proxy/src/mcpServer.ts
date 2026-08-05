import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  validateFruit,
  resolveBoundaryWithRetry,
  readSessionTranscript,
  loadConfig,
  applyConfigPatch,
  saveConfig,
  appendAuditEntry,
  recordDistillate,
  readReportRange,
  readCapsule,
  findCapsuleEntry,
} from "mekiri-core";
import type { NoteType, PortalFruit, DeathReloadFruit, MekiriConfig } from "mekiri-core";
import type { RewriteRule } from "./rewriteMessages.js";
import { spawnClone } from "./spawnClone.js";

export interface McpServerContext {
  sessionId: string;
  dir: string;
  depth: number;
  daemonPort: number;
  postControlRule: (body: { sessionId: string; dir: string; rule: RewriteRule }) => Promise<void>;
}

export function postControlRuleOverHttp(daemonPort: number) {
  return (body: { sessionId: string; dir: string; rule: RewriteRule }): Promise<void> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const req = http.request(
        { hostname: "127.0.0.1", port: daemonPort, path: "/control/rule", method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`daemon returned ${res.statusCode}`))));
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
}

function renderDistillate(noteType: NoteType, fruit: PortalFruit | DeathReloadFruit): string {
  if (noteType === "portal") {
    const p = fruit as PortalFruit;
    const parts = [`Дистиллят: ${p.summary}`];
    if (p.files_touched?.length) parts.push(`Изменённые файлы: ${p.files_touched.map((f) => `${f.path} (${f.change})`).join(", ")}`);
    if (p.gotchas) parts.push(`Подводные камни: ${p.gotchas}`);
    return parts.join("\n");
  }
  const d = fruit as DeathReloadFruit;
  const parts = [`Пробовал: ${d.tried}`, `Исключено: ${d.ruled_out}`];
  if (d.facts_learned) parts.push(`Факты: ${d.facts_learned}`);
  return parts.join("\n");
}

/** First line of the relevant fruit field (`summary` for portal, `tried` for
 *  death_reload), trimmed and collapsed to a single line, truncated to ~80
 *  chars -- used as the human-readable label in capsule.md. Shared by `tag`
 *  and the `prune` handler's report-store write. */
function deriveHeader(noteType: NoteType, fruit: PortalFruit | DeathReloadFruit): string {
  const raw = noteType === "portal" ? (fruit as PortalFruit).summary : (fruit as DeathReloadFruit).tried;
  const firstLine = raw.split(/\r?\n/)[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
}

interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

type PruneResult =
  | { status: "ok"; cut_effective_from: "next_request"; rule_id: string; distillate: string }
  | { status: "ambiguous"; occurrences: number }
  | { status: "not_found" }
  | { status: "in_compacted_zone"; last_compact_message_id: string }
  | { status: "invalid_fruit"; errors: string[] };

interface ConfigureArgs {
  patch: Partial<MekiriConfig>;
  reason: string;
}

type ConfigureResult = { status: "ok" } | { status: "invalid"; errors: string[] };

interface SproutArgs {
  task: string;
  wait_mode?: "sync" | "async";
}

type SproutResult =
  | { status: "ok"; child_session_id: string; result: string }
  | { status: "depth_limit_exceeded" }
  | { status: "async_not_supported" };

interface TagArgs {
  quote: string;
  fruit: unknown;
}

type TagResult =
  | { status: "ok"; rule_id: string }
  | { status: "ambiguous"; occurrences: number }
  | { status: "not_found" }
  | { status: "in_compacted_zone"; last_compact_message_id: string }
  | { status: "invalid_fruit"; errors: string[] };

interface GraftArgs {
  target?: string;
}

type GraftResult =
  | { status: "ok"; mode: "toc"; content: string }
  | { status: "ok"; mode: "full"; content: string }
  | { status: "not_found" };

export function createToolHandlers(context: McpServerContext) {
  return {
    async prune(args: PruneArgs): Promise<PruneResult> {
      const validation = validateFruit({ noteType: args.note_type, fruit: args.fruit, keepCode: args.keep_code });
      if (!validation.ok) {
        return { status: "invalid_fruit", errors: validation.errors };
      }

      const { transcript, boundary } = await resolveBoundaryWithRetry(
        () => readSessionTranscript(context.dir, context.sessionId),
        args.quote,
      );
      if (boundary.status === "not_found") return { status: "not_found" };
      if (boundary.status === "ambiguous") return { status: "ambiguous", occurrences: boundary.occurrences };
      if (boundary.status === "in_compacted_zone") {
        return { status: "in_compacted_zone", last_compact_message_id: boundary.lastCompactMessageId };
      }

      // Validation only -- findBoundary confirms the quote is unambiguous against
      // the local transcript right now, so the agent gets an immediate error on a
      // bad quote. The actual cut position is resolved later, fresh, by
      // rewriteMessages() against each real request's messages[] array (see
      // RewriteRule.matchQuote) -- not computed here, per Task 2's finding.
      const filtered = transcript.filter((l) => l.type === "user" || l.type === "assistant");
      const idx = filtered.findIndex((l) => l.uuid === boundary.messageId);

      const distillateText = renderDistillate(args.note_type, validation.fruit);
      const id = randomUUID();
      const rule: RewriteRule = { id, matchQuote: args.quote };

      const header = deriveHeader(args.note_type, validation.fruit);
      await recordDistillate(
        context.dir,
        { event: "prune", sessionId: context.sessionId, ruleId: id, noteType: args.note_type, timestamp: new Date().toISOString() },
        header,
        distillateText,
      );

      await context.postControlRule({ sessionId: context.sessionId, dir: context.dir, rule });
      await appendAuditEntry(context.dir, {
        event: "prune",
        timestamp: new Date().toISOString(),
        sessionId: context.sessionId,
        ruleId: id,
        noteType: args.note_type,
        removedBranchLength: JSON.stringify(filtered.slice(idx + 1)).length,
        fruitLength: distillateText.length,
      });

      return { status: "ok", cut_effective_from: "next_request", rule_id: id, distillate: distillateText };
    },

    async tag(args: TagArgs): Promise<TagResult> {
      const validation = validateFruit({ noteType: "portal", fruit: args.fruit, keepCode: true });
      if (!validation.ok) {
        return { status: "invalid_fruit", errors: validation.errors };
      }

      // Same boundary lookup as prune -- proves the quote is a real, unambiguous
      // position in the transcript -- but tag never posts a rewrite rule: the
      // marked range stays live in context, this only anchors+measures it.
      const { transcript, boundary } = await resolveBoundaryWithRetry(
        () => readSessionTranscript(context.dir, context.sessionId),
        args.quote,
      );
      if (boundary.status === "not_found") return { status: "not_found" };
      if (boundary.status === "ambiguous") return { status: "ambiguous", occurrences: boundary.occurrences };
      if (boundary.status === "in_compacted_zone") {
        return { status: "in_compacted_zone", last_compact_message_id: boundary.lastCompactMessageId };
      }

      const filtered = transcript.filter((l) => l.type === "user" || l.type === "assistant");
      const idx = filtered.findIndex((l) => l.uuid === boundary.messageId);

      const header = deriveHeader("portal", validation.fruit);
      const distillateText = renderDistillate("portal", validation.fruit);
      const id = randomUUID();
      const timestamp = new Date().toISOString();

      await recordDistillate(
        context.dir,
        { event: "tag", sessionId: context.sessionId, ruleId: id, noteType: "portal", timestamp },
        header,
        distillateText,
      );
      await appendAuditEntry(context.dir, {
        event: "tag",
        timestamp,
        sessionId: context.sessionId,
        ruleId: id,
        markedLength: JSON.stringify(filtered.slice(0, idx + 1)).length,
        fruitLength: distillateText.length,
      });

      return { status: "ok", rule_id: id };
    },

    async graft(args: GraftArgs): Promise<GraftResult> {
      const timestamp = new Date().toISOString();

      if (!args.target) {
        const content = await readCapsule(context.dir, context.sessionId);
        await appendAuditEntry(context.dir, {
          event: "graft",
          timestamp,
          sessionId: context.sessionId,
          mode: "toc",
        });
        return { status: "ok", mode: "toc", content };
      }

      const entry = await findCapsuleEntry(context.dir, args.target);
      if (!entry) return { status: "not_found" };

      const body = await readReportRange(context.dir, entry.sessionId, entry.startLine, entry.endLine);
      const content = `[graft: ${entry.event} ${entry.ruleId}, session ${entry.sessionId}, ${entry.timestamp}]\n${body}`;

      await appendAuditEntry(context.dir, {
        event: "graft",
        timestamp,
        sessionId: context.sessionId,
        targetRuleId: args.target,
        mode: "full",
      });

      return { status: "ok", mode: "full", content };
    },

    async configure_mekiri(args: ConfigureArgs): Promise<ConfigureResult> {
      const current = await loadConfig(context.dir);
      const result = applyConfigPatch(current, args.patch);
      if (result.status === "invalid") return { status: "invalid", errors: result.errors };
      await saveConfig(context.dir, result.config);
      await appendAuditEntry(context.dir, {
        event: "configure_mekiri",
        timestamp: new Date().toISOString(),
        reason: args.reason,
        patch: args.patch,
      });
      return { status: "ok" };
    },

    async sprout(args: SproutArgs): Promise<SproutResult> {
      if (args.wait_mode === "async") {
        return { status: "async_not_supported" };
      }

      const config = await loadConfig(context.dir);
      if (context.depth >= config.sprout.depth_limit) {
        return { status: "depth_limit_exceeded" };
      }

      const { childSessionId, result } = await spawnClone({
        sessionId: context.sessionId,
        task: args.task,
        dir: context.dir,
        proxyPort: context.daemonPort,
        depth: context.depth + 1,
      });

      const transcript = await readSessionTranscript(context.dir, context.sessionId);

      await appendAuditEntry(context.dir, {
        event: "sprout",
        timestamp: new Date().toISOString(),
        sessionId: context.sessionId,
        childSessionId,
        branchLength: JSON.stringify(transcript).length,
        harvestLength: result.length,
      });

      return { status: "ok", child_session_id: childSessionId, result };
    },
  };
}
