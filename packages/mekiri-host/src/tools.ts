import { z } from "zod";
import { tool, createSdkMcpServer, forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateFruit, findBoundary, createBranch, loadConfig, saveConfig, applyConfigPatch, appendAuditEntry } from "mekiri-core";
import type { RawLine, NoteType, CreateBranchArgs, CreateBranchResult, SproutAuditEntry, ConfigureAuditEntry } from "mekiri-core";
import { runClone } from "./clone.js";
import type { CloneDynamicContext } from "./clone.js";

// The Agent SDK's forkSession() reads the source session's transcript
// straight off disk. Its write path streams SDKAssistantMessage objects to
// this process as soon as they're produced, but the underlying CLI
// subprocess flushes the corresponding line to the on-disk .jsonl file
// slightly later and asynchronously (there is no public knob to force a
// synchronous flush before fork — see Options.sessionStoreFlush, which is
// documented as only applying to the opt-in external SessionStore feature
// we don't use). If createBranch()'s forkSession call lands in that gap, it
// throws a plain `Error` with a message of the shape
// "Message <uuid> not found in session <sessionId>" (see the SDK's `mF`
// helper in sdk.mjs) even though the message legitimately exists and will
// be on disk moments later.
//
// This was confirmed empirically (not just theorized): a standalone repro
// script that called forkSession immediately upon receiving the matching
// SDKAssistantMessage failed 7/7 times at t=0ms, still failed most of the
// time at t+50ms, and consistently succeeded by t+100..350ms cumulative
// wait. The retry schedule below is sized with headroom above that
// observed window while staying well under "feels sluggish" territory.
const FORK_RETRY_DELAYS_MS = [50, 100, 200, 400];

function isTransientForkNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found in session/.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createBranchWithRetry(args: CreateBranchArgs): Promise<CreateBranchResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createBranch(args);
    } catch (err) {
      const attemptsLeft = attempt < FORK_RETRY_DELAYS_MS.length;
      if (!isTransientForkNotFoundError(err) || !attemptsLeft) {
        throw err;
      }
      await sleep(FORK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export interface MekiriToolsContext {
  dir: string;
  depth: number;
  isClone: boolean;
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
  onHarvest: (result: string, needsCleanLook: boolean) => void;
}

export interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

export interface PruneToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handlePrune(context: MekiriToolsContext, args: PruneArgs): Promise<PruneToolResult> {
  const validation = validateFruit({
    noteType: args.note_type,
    fruit: args.fruit,
    keepCode: args.keep_code,
  });
  if (!validation.ok) {
    return { content: [{ type: "text", text: `invalid fruit: ${validation.errors.join("; ")}` }], isError: true };
  }

  const transcript = context.getTranscript();
  const boundary = findBoundary(transcript, args.quote);
  if (boundary.status !== "ok") {
    return { content: [{ type: "text", text: JSON.stringify(boundary) }] };
  }

  const boundaryIndex = transcript.findIndex((line) => line.uuid === boundary.uuid);
  const removedLines = boundaryIndex >= 0 ? transcript.slice(boundaryIndex + 1) : [];
  const removedBranchLength = JSON.stringify(removedLines).length;
  const fruitLength = JSON.stringify(validation.fruit).length;

  let newSessionId: string;
  try {
    ({ newSessionId } = await createBranchWithRetry({
      branchType: "prune",
      sessionId: context.getSessionId(),
      dir: context.dir,
      upToMessageId: boundary.uuid,
      noteType: args.note_type,
      removedBranchLength,
      fruitLength,
      auditProjectDir: context.dir,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: isTransientForkNotFoundError(err)
            ? `prune failed: the session transcript hadn't finished writing to disk in time (retried ${FORK_RETRY_DELAYS_MS.length} times over ~${FORK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms). Try again in a moment. (${message})`
            : `prune failed: ${message}`,
        },
      ],
      isError: true,
    };
  }

  const injectText = [
    "[branch_type:prune, branch archived, resuming from fruit]",
    JSON.stringify({ note_type: args.note_type, fruit: validation.fruit }, null, 2),
  ].join("\n");

  context.onSwitch(newSessionId, injectText);

  return { content: [{ type: "text", text: `ok: new_session_id=${newSessionId}` }] };
}

export interface HarvestArgs {
  result: string;
  needs_clean_look?: boolean;
}

export async function handleHarvest(context: MekiriToolsContext, args: HarvestArgs): Promise<PruneToolResult> {
  if (!context.isClone) {
    return { content: [{ type: "text", text: "harvest валиден только внутри sprout-клона" }], isError: true };
  }
  context.onHarvest(args.result, args.needs_clean_look ?? false);
  return { content: [{ type: "text", text: "ok" }] };
}

export interface SproutArgs {
  task: string;
}

export async function handleSprout(context: MekiriToolsContext, args: SproutArgs): Promise<PruneToolResult> {
  const config = await loadConfig(context.dir);
  const childDepth = context.depth + 1;
  if (childDepth > config.sprout.depth_limit) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "depth_limit_exceeded" }) }] };
  }

  const { sessionId: forkedSessionId } = await forkSession(context.getSessionId(), { dir: context.dir });

  const buildTools = (dynamic: CloneDynamicContext) =>
    createMekiriTools({
      dir: context.dir,
      depth: childDepth,
      isClone: true,
      ...dynamic,
    });

  // Found by live dogfooding (not anticipated in the plan): without explicit
  // framing, a model forked into a clone with no other context has no way
  // to know it *is* a clone -- the harvest tool's own description says
  // "only valid inside a sprout clone," and a model reasonably refuses to
  // call it rather than assume that's true. The inherited context (whatever
  // the parent already knew about prune/sprout/harvest, per the cache
  // invariant -- see 2026-07-24-core-primitive-design.md §2) is not enough
  // on its own; the tail message has to say so explicitly, the same way
  // prune's injectText frames the post-prune continuation.
  const framedTask = [
    "[branch_type:sprout] You are a warm clone, just forked from a parent session to work one task in isolation.",
    "Your task:",
    args.task,
    "",
    "When you're done, call harvest with your result -- the parent is waiting for it and will not see anything else you do here.",
    "If a hypothesis or approach doesn't pan out along the way, prune works exactly as it would for your parent: archive the dead end and continue from a distilled note.",
  ].join("\n");

  const cloneResult = await runClone(framedTask, forkedSessionId, context.dir, buildTools);

  const auditEntry: SproutAuditEntry = {
    event: "sprout",
    timestamp: new Date().toISOString(),
    sessionId: context.getSessionId(),
    childSessionId: forkedSessionId,
    branchLength: cloneResult.branchLength,
    harvestLength: JSON.stringify(cloneResult.result).length,
  };
  await appendAuditEntry(context.dir, auditEntry);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          branch_type: "sprout",
          child_session_id: forkedSessionId,
          result: cloneResult.result,
          ...(cloneResult.harvestedImplicitly ? { harvested_implicitly: true } : {}),
          ...(cloneResult.needsCleanLook ? { needs_clean_look: true } : {}),
        }),
      },
    ],
  };
}

export interface ConfigureArgs {
  patch: Record<string, unknown>;
  reason: string;
}

export async function handleConfigure(context: MekiriToolsContext, args: ConfigureArgs): Promise<PruneToolResult> {
  const current = await loadConfig(context.dir);
  const result = applyConfigPatch(current, args.patch);
  if (result.status === "invalid") {
    return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", errors: result.errors }) }], isError: true };
  }

  await saveConfig(context.dir, result.config);

  const auditEntry: ConfigureAuditEntry = {
    event: "configure_mekiri",
    timestamp: new Date().toISOString(),
    reason: args.reason,
    patch: args.patch,
  };
  await appendAuditEntry(context.dir, auditEntry);

  return { content: [{ type: "text", text: JSON.stringify({ status: "ok", config: result.config }) }] };
}

export function createMekiriTools(context: MekiriToolsContext): McpSdkServerConfigWithInstance {
  const pruneTool = tool(
    "prune",
    "Cut the dirty tail of the current session: archive it and continue from a distilled note. Use when a side investigation is done and its raw process is no longer needed.",
    {
      quote: z.string().describe("Verbatim opening sentence of your own turn where the garbage begins"),
      note_type: z.enum(["portal", "death_reload"]),
      fruit: z.record(z.string(), z.unknown()).describe("portal: {summary, files_touched?, gotchas?}. death_reload: {tried, ruled_out, facts_learned?, trigger?}"),
      keep_code: z.boolean().default(true),
    },
    async (args) => (await handlePrune(context, args as PruneArgs)) as CallToolResult,
  );

  const harvestTool = tool(
    "harvest",
    "Return your result to the parent that sprouted you and end this clone. Only valid inside a sprout clone.",
    {
      result: z.string().describe("The distilled result to hand back to the parent"),
      needs_clean_look: z
        .boolean()
        .optional()
        .describe("Set true to flag that this result is uncertain and the parent should get a fresh perspective instead of trusting it"),
    },
    async (args) => (await handleHarvest(context, args as HarvestArgs)) as CallToolResult,
  );

  const sproutTool = tool(
    "sprout",
    "Fork a warm clone of the current session to work a side task in isolation, without disturbing this session. The clone inherits full context and can use prune/sprout/harvest itself. Call harvest inside the clone when its task is done.",
    {
      task: z.string().describe("The clone's new main task, appended to its copy of the current context"),
    },
    async (args) => (await handleSprout(context, args as SproutArgs)) as CallToolResult,
  );

  // Deliberately unrestricted: a clone at any depth can patch any field,
  // including sprout.depth_limit -- which elsewhere in this file acts as a
  // safety ceiling on sprout recursion (see handleSprout's depth check).
  // Flagged in the final whole-branch review of this feature; the project
  // owner's explicit call was to accept this rather than add isClone
  // gating or a schema-level max, since the audit log's `reason` field
  // already records who changed it and why. Revisit if runaway sprout
  // recursion driven by a self-escalated depth_limit is ever observed.
  const configureTool = tool(
    "configure_mekiri",
    "Patch Mekiri's own runtime configuration (.mekiri/config.json): sprout.depth_limit, sprout.parallelism, sprout.wait_mode, priorities.token_efficiency. The patch is deep-merged with the current config and validated as a whole; an invalid patch is rejected with no changes made. Available to the parent and to clones at any depth.",
    {
      patch: z.record(z.string(), z.unknown()).describe("Partial config object, deep-merged with the current config"),
      reason: z.string().describe("Why this change is being made -- recorded in the audit log"),
    },
    async (args) => (await handleConfigure(context, args as ConfigureArgs)) as CallToolResult,
  );

  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool, sproutTool, harvestTool, configureTool] });
}
