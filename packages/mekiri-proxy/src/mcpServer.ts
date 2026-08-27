import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  validateFruit,
  resolveBoundaryWithRetry,
  readSessionTranscript,
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
import { loadHookState, saveHookState } from "./hookState.js";
import { readShadowTranscript, readShadowTranscriptOrNull } from "./shadowTranscript.js";

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
    const parts = [`Distillate: ${p.summary}`];
    if (p.files_touched?.length) parts.push(`Files touched: ${p.files_touched.map((f) => `${f.path} (${f.change})`).join(", ")}`);
    if (p.gotchas) parts.push(`Gotchas: ${p.gotchas}`);
    return parts.join("\n");
  }
  const d = fruit as DeathReloadFruit;
  const parts = [`Tried: ${d.tried}`, `Ruled out: ${d.ruled_out}`];
  if (d.facts_learned) parts.push(`Facts: ${d.facts_learned}`);
  return parts.join("\n");
}

/** `fruit.conclusion`, trimmed and collapsed to a single line, truncated to
 *  ~80 chars as a defensive cap (not the primary truncation mechanism -- the
 *  agent is expected to already write a short label) -- used as the
 *  human-readable label in capsule.md. */
function deriveHeader(fruit: PortalFruit | DeathReloadFruit): string {
  const firstLine = fruit.conclusion.split(/\r?\n/)[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
}

interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

type PruneResult =
  | {
      status: "ok";
      cut_effective_from: "next_request";
      rule_id: string;
      distillate: string;
      unverified_files?: string[];
      coverage_hint?: string;
    }
  | { status: "ambiguous"; occurrences: number; hint: string }
  | { status: "not_found"; hint: string }
  | { status: "in_compacted_zone"; last_compact_message_id: string; hint: string }
  | { status: "invalid_fruit"; errors: string[] };

// Shown on every failed quote-resolution outcome (not_found/ambiguous/
// in_compacted_zone) -- this is the moment of maximum pressure to fabricate
// a quote (see feedback_mekiri_fruit_accuracy memory, 2026-08-25 incident):
// the agent is staring at exactly this response with a nudge-hook threshold
// looming and no valid quote in hand. quote: "" already exists, is fully
// honest, and already resets the nudge state -- the fix is surfacing it
// right here instead of relying on the agent recalling it from a skill file
// under pressure.
const NOT_FOUND_HINT =
  "Нет совпадения для этой цитаты в транскрипте. Если резать реально нечего прямо сейчас " +
  "(например, цитата — из ещё не завершённого текущего хода, который физически не мог успеть " +
  "записаться на диск) — вызови prune с quote: \"\" и опиши то, что стоит сохранить, в kept_context. " +
  "Это полноценный вызов Mekiri-тулзы, засчитывается и сбрасывает счётчик напоминаний хука. " +
  "Никогда не изобретай цитату, которой не было.";
const AMBIGUOUS_HINT =
  "Эта цитата встречается в транскрипте несколько раз — нужен более длинный, однозначный фрагмент. " +
  "Если однозначную цитату сейчас не найти и резать реально нечего — не пытайся угадывать короче " +
  "или длиннее, используй quote: \"\" вместо этого.";
const IN_COMPACTED_ZONE_HINT =
  "Эта цитата находится до последней точки компакции — в живом транскрипте её больше нет, резать " +
  "оттуда нельзя. Если важно сохранить что-то из этого диапазона, опиши это в kept_context при " +
  "следующем prune (с quote: \"\" или с валидной цитатой из текущей, некомпактированной зоны).";

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

      // Set by bin/stop-hook.ts when it force-blocked a Stop event: the
      // report the agent just wrote, which must survive this prune's cut
      // even though nothing (no user message) separates it from this call's
      // own tool_use anchor. Consumed below (threaded into rule via
      // preserveFromQuote) and cleared after processing regardless of
      // hasCut -- one-shot, same pattern as nudge.deferCalls.
      const hookState = await loadHookState(context.dir, context.sessionId);
      const stopBoundary = hookState?.stopBoundary;

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
      // The same shadow-transcript array rawEndLine was resolved against,
      // passed through to recordDistillate so it can slice out exactly the
      // rawStartLine..rawEndLine range it's about to chain and compute a
      // mechanical activityLog from it -- see verifyFruitEvidence.ts's
      // summarizeToolActivity.
      let rawTranscript: RawLine[] | undefined;

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
        if (boundary.status === "not_found") return { status: "not_found", hint: NOT_FOUND_HINT };
        if (boundary.status === "ambiguous") {
          return { status: "ambiguous", occurrences: boundary.occurrences, hint: AMBIGUOUS_HINT };
        }
        if (boundary.status === "in_compacted_zone") {
          return {
            status: "in_compacted_zone",
            last_compact_message_id: boundary.lastCompactMessageId,
            hint: IN_COMPACTED_ZONE_HINT,
          };
        }

        filtered = transcript.filter((l) => l.type === "user" || l.type === "assistant");
        cutIdx = filtered.findIndex((l) => l.uuid === boundary.messageId);

        // Archival position of the same quote, resolved independently
        // against the durable shadow transcript (mekiri-proxy's own
        // append-only copy) rather than the position within `transcript`
        // above -- that position lives in Claude Code's own mutable .jsonl
        // numbering, which is not safe to record long-term (see
        // shadowTranscript.ts). If the shadow transcript hasn't caught up
        // yet (or the quote genuinely isn't in it) even after retrying,
        // fall back to the transcript's current full length rather than
        // leaving rawEndLine undefined: an undefined rawEndLine makes
        // recordDistillate skip raw-range recording for this entry
        // entirely, which is indistinguishable from a legacy pre-shadow
        // entry and, if this happens to be the session's last prune call,
        // permanently strands that tail of raw transcript outside the
        // graftable chain (nothing after it exists to "absorb" it). The
        // fallback is deliberately wider than the precise boundary would
        // have been -- graft returning extra raw content is always safer
        // than graft silently having none.
        const shadowResult = await resolveBoundaryWithRetry(
          () => readShadowTranscript(context.sessionId),
          args.quote,
        );
        const shadowBoundary = shadowResult.boundary;
        const shadowIdx =
          shadowBoundary.status === "ok"
            ? shadowResult.transcript.findIndex((l) => l.uuid === shadowBoundary.messageId)
            : -1;
        // length > 0 guards the genuine "shadow file doesn't exist yet"
        // case (readShadowTranscript returns [] for both a missing file and
        // a merely-empty one) -- falling back to 0 there would record an
        // inverted rawStartLine=1/rawEndLine=0 range instead of correctly
        // skipping raw-range recording for nothing having been captured yet.
        if (shadowIdx >= 0) {
          rawEndLine = shadowIdx + 1;
        } else if (shadowResult.transcript.length > 0) {
          rawEndLine = shadowResult.transcript.length;
        }
        rawTranscript = shadowResult.transcript;

        rule = {
          id,
          matchQuote: args.quote,
          ...(stopBoundary ? { preserveFromQuote: stopBoundary.lastAssistantMessage } : {}),
        };
      } else {
        const shadowTranscript = await readShadowTranscriptOrNull(context.sessionId);
        if (shadowTranscript !== null) {
          rawEndLine = shadowTranscript.length;
          rawTranscript = shadowTranscript;
        }
      }

      const keptContext = (validation.fruit as PortalFruit | DeathReloadFruit).kept_context;
      const parts: ("kept" | "cut")[] = [];
      const sections: string[] = [];
      if (keptContext.trim() !== "") {
        parts.push("kept");
        sections.push("Kept in context: " + keptContext);
      }
      if (hasCut) {
        parts.push("cut");
        sections.push(renderDistillate(args.note_type, validation.fruit));
      }
      const distillateText = sections.join("\n\n");

      const header = deriveHeader(validation.fruit);
      const { rawSpanLength } = await recordDistillate(
        context.dir,
        {
          event: "prune",
          sessionId: context.sessionId,
          ruleId: id,
          noteType: args.note_type,
          timestamp,
          parts,
          rawEndLine,
          rawSource: rawEndLine !== undefined ? "shadow" : undefined,
          rawTranscript,
        },
        header,
        distillateText,
      );

      // Non-blocking evidence, not proof -- same spirit as unverifiedFiles
      // below. A large raw span (this entry covers a lot of real transcript)
      // paired with near-empty combined prose is exactly the "chat report
      // richer than the archive" shape of the 2026-08-26 incident: the agent
      // genuinely believed it archived enough, and nothing forced a second
      // look. This can only flag for the agent's own judgment, never reject
      // the call -- a legitimately quiet stretch (re-reading a file,
      // confirming a hypothesis) can have a large raw span and truthfully
      // nothing worth keeping.
      const combinedProseLength =
        keptContext.trim().length +
        (hasCut ? ((validation.fruit as PortalFruit | DeathReloadFruit).conclusion.trim().length + distillateText.length) : 0);
      const coverageHint =
        rawSpanLength !== undefined && rawSpanLength > 20 && combinedProseLength < 30
          ? `Этот вызов охватывает ${rawSpanLength} строк сырого транскрипта, но kept_context/summary почти пустые -- ` +
            "если там на самом деле что-то важное происходило, стоит перепроверить перед следующим prune."
          : undefined;

      const unverifiedFiles =
        hasCut && args.note_type === "portal"
          ? findUnverifiedPaths(filtered.slice(cutIdx), validation.fruit as PortalFruit)
          : [];

      if (rule) {
        await context.postControlRule({ sessionId: context.sessionId, dir: context.dir, rule });
      }

      // One-shot consumption: the agent reacted to the Stop-forced block by
      // calling prune (cutting or not), so the flag is spent either way --
      // leaving it set would make the *next* ordinary prune call also try to
      // preserve a now-stale report.
      if (stopBoundary) {
        // hookState is necessarily defined here: stopBoundary was read from
        // hookState?.stopBoundary above, so a truthy stopBoundary implies a
        // defined hookState -- TS can't link the two through the
        // intermediate const, hence the assertion.
        await saveHookState(context.dir, context.sessionId, { ...hookState!, stopBoundary: undefined });
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
        ...(coverageHint ? { coverage_hint: coverageHint } : {}),
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

      // Entries written before raw-range recording existed, or before the
      // durable shadow transcript existed (rawSource !== "shadow"), have no
      // reliable rawStartLine/rawEndLine to look up -- a legacy entry's
      // numbers point into Claude Code's own (possibly since-shrunk) .jsonl
      // file, not the shadow transcript. Graceful, explicit status, never a
      // silent fall-back to the distillate or a near-empty slice.
      if (entry.rawStartLine === undefined || entry.rawEndLine === undefined || entry.rawSource !== "shadow") {
        return { status: "no_raw_range" };
      }

      const transcript = await readShadowTranscriptOrNull(entry.sessionId);
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
