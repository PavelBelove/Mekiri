import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  validateFruit,
  resolveBoundaryWithRetry,
  readSessionTranscript,
  readSessionTranscriptOrNull,
  renderRawLines,
  loadConfig,
  applyConfigPatch,
  saveConfig,
  appendAuditEntry,
  recordDistillate,
  readCapsule,
  findCapsuleEntry,
  computeProjectReport,
  findUnverifiedPaths,
} from "mekiri-core";
import type { NoteType, PortalFruit, DeathReloadFruit, MekiriConfig, TreeMetricsReport, ProjectMetricsReport, RawLine } from "mekiri-core";
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
function deriveHeader(noteType: NoteType, fruit: PortalFruit | DeathReloadFruit, hasCut: boolean): string {
  const raw = !hasCut
    ? (fruit as PortalFruit).kept_context
    : noteType === "portal"
      ? (fruit as PortalFruit).summary
      : (fruit as DeathReloadFruit).tried;
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
  | { status: "ok"; cut_effective_from: "next_request"; rule_id: string; distillate: string; unverified_files?: string[] }
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

interface GraftArgs {
  target?: string;
}

// Raw ranges can genuinely run 100-200K characters (a long tool-call-heavy
// stretch of transcript). Hard-truncating rather than returning it whole is
// a judgment call, not a spec'd requirement -- 20000 chars (~5k tokens) is
// picked as a size that's still useful context without risking blowing out
// the caller's own budget on one graft call.
const RAW_CONTENT_CHAR_LIMIT = 20000;

type GraftResult =
  | { status: "ok"; mode: "toc"; content: string }
  | { status: "ok"; mode: "raw"; content: string; length: number; truncated?: boolean }
  | { status: "not_found" }
  // The target entry predates raw-range recording (written before this
  // feature existed) -- no rawStartLine/rawEndLine to look up.
  | { status: "no_raw_range" }
  // rawStartLine/rawEndLine are recorded, but the raw transcript file for
  // that session is missing on disk (e.g. moved, deleted, different
  // machine). Never silently falls back to the distillate.
  | { status: "transcript_unavailable" };

interface MetricsArgs {
  scope?: "session" | "project";
}

type MetricsResult =
  | { status: "ok"; scope: "session"; report: TreeMetricsReport }
  | { status: "ok"; scope: "project"; report: ProjectMetricsReport }
  | { status: "not_found" };

export function createToolHandlers(context: McpServerContext) {
  return {
    async prune(args: PruneArgs): Promise<PruneResult> {
      const validation = validateFruit({
        noteType: args.note_type,
        fruit: args.fruit,
        keepCode: args.keep_code,
        quote: args.quote,
      });
      if (!validation.ok) {
        return { status: "invalid_fruit", errors: validation.errors };
      }

      const hasCut = args.quote !== "";
      const timestamp = new Date().toISOString();
      const id = randomUUID();

      let filtered: RawLine[] = [];
      let cutIdx = -1;
      let rule: RewriteRule | undefined;
      // 1-based index of the last raw transcript line this entry covers --
      // the cut boundary's position in the raw (unfiltered) transcript for a
      // "cut" entry, or the transcript's current length for kept-only.
      // Undefined when the transcript couldn't be read at all, so
      // recordDistillate skips raw-range recording rather than storing a
      // bogus one -- graft must later report that gracefully, not crash.
      let rawEndLine: number | undefined;

      if (hasCut) {
        // Validation only -- findBoundary confirms the quote is unambiguous against
        // the local transcript right now, so the agent gets an immediate error on a
        // bad quote. The actual cut position is resolved later, fresh, by
        // rewriteMessages() against each real request's messages[] array (see
        // RewriteRule.matchQuote) -- not computed here, per Task 2's finding.
        const { transcript, boundary } = await resolveBoundaryWithRetry(
          () => readSessionTranscript(context.dir, context.sessionId),
          args.quote,
        );
        if (boundary.status === "not_found") return { status: "not_found" };
        if (boundary.status === "ambiguous") return { status: "ambiguous", occurrences: boundary.occurrences };
        if (boundary.status === "in_compacted_zone") {
          return { status: "in_compacted_zone", last_compact_message_id: boundary.lastCompactMessageId };
        }

        filtered = transcript.filter((l) => l.type === "user" || l.type === "assistant");
        cutIdx = filtered.findIndex((l) => l.uuid === boundary.messageId);

        // Position of the same boundary message within the raw (unfiltered)
        // transcript -- NOT cutIdx, which indexes into `filtered`.
        const rawBoundaryIdx = transcript.findIndex((l) => l.uuid === boundary.messageId);
        if (rawBoundaryIdx >= 0) rawEndLine = rawBoundaryIdx + 1;

        rule = { id, matchQuote: args.quote };
      } else {
        const transcript = await readSessionTranscriptOrNull(context.dir, context.sessionId);
        if (transcript !== null) rawEndLine = transcript.length;
      }

      const keptContext = (validation.fruit as PortalFruit | DeathReloadFruit).kept_context;
      const parts: ("kept" | "cut")[] = [];
      const sections: string[] = [];
      if (keptContext.trim() !== "") {
        parts.push("kept");
        sections.push("Важное (осталось в контексте): " + keptContext);
      }
      if (hasCut) {
        parts.push("cut");
        sections.push(renderDistillate(args.note_type, validation.fruit));
      }
      const distillateText = sections.join("\n\n");

      const header = deriveHeader(args.note_type, validation.fruit, hasCut);
      await recordDistillate(
        context.dir,
        { event: "prune", sessionId: context.sessionId, ruleId: id, noteType: args.note_type, timestamp, parts, rawEndLine },
        header,
        distillateText,
      );

      const unverifiedFiles =
        hasCut && args.note_type === "portal"
          ? findUnverifiedPaths(filtered.slice(cutIdx), validation.fruit as PortalFruit)
          : [];

      if (rule) {
        await context.postControlRule({ sessionId: context.sessionId, dir: context.dir, rule });
      }

      await appendAuditEntry(context.dir, {
        event: "prune",
        timestamp,
        sessionId: context.sessionId,
        ruleId: id,
        noteType: args.note_type,
        parts,
        ...(hasCut ? { removedBranchLength: JSON.stringify(filtered.slice(cutIdx + 1)).length } : {}),
        ...(parts.includes("kept") ? { markedLength: keptContext.length } : {}),
        fruitLength: distillateText.length,
        ...(unverifiedFiles.length > 0 ? { unverifiedFiles } : {}),
      });

      return {
        status: "ok",
        cut_effective_from: "next_request",
        rule_id: id,
        distillate: distillateText,
        ...(unverifiedFiles.length > 0 ? { unverified_files: unverifiedFiles } : {}),
      };
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

      // Entries written before raw-range recording existed have no
      // rawStartLine/rawEndLine to look up -- graceful, explicit status,
      // never a silent fall-back to the distillate.
      if (entry.rawStartLine === undefined || entry.rawEndLine === undefined) {
        return { status: "no_raw_range" };
      }

      const transcript = await readSessionTranscriptOrNull(context.dir, entry.sessionId);
      if (transcript === null) return { status: "transcript_unavailable" };

      // The recorded range can outrun what's actually on disk (e.g. a
      // differently-provisioned machine, or a transcript file that was
      // rotated) -- clamp rather than throw, and say so via `truncated`.
      const clampedEndLine = Math.min(entry.rawEndLine, transcript.length);
      const rawSlice = transcript.slice(entry.rawStartLine - 1, clampedEndLine);
      const rendered = renderRawLines(rawSlice);
      const header = `[graft: ${entry.event} ${entry.ruleId}, session ${entry.sessionId}, ${entry.timestamp}]\n`;
      const fullContent = header + rendered;

      const overSizeLimit = fullContent.length > RAW_CONTENT_CHAR_LIMIT;
      const content = overSizeLimit
        ? fullContent.slice(0, RAW_CONTENT_CHAR_LIMIT) +
          `\n\n[...truncated, showing ${RAW_CONTENT_CHAR_LIMIT} of ${fullContent.length} chars...]`
        : fullContent;

      await appendAuditEntry(context.dir, {
        event: "graft",
        timestamp,
        sessionId: context.sessionId,
        targetRuleId: args.target,
        mode: "raw",
      });

      return {
        status: "ok",
        mode: "raw",
        content,
        length: fullContent.length,
        ...(overSizeLimit ? { truncated: true } : {}),
      };
    },

    async metrics(args: MetricsArgs): Promise<MetricsResult> {
      const projectReport = await computeProjectReport(context.dir);

      if (args.scope === "project") {
        return { status: "ok", scope: "project", report: projectReport };
      }

      // Wire-level prune (mekiri-proxy) never forks the running session, so
      // context.sessionId is always the real, stable id -- and always equal
      // to its own tree's rootSessionId (only sprout children get a
      // different real sessionId, as childSessionId, never the running
      // session itself).
      const tree = projectReport.trees.find((t) => t.rootSessionId === context.sessionId);
      if (!tree) return { status: "not_found" };
      return { status: "ok", scope: "session", report: tree };
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
