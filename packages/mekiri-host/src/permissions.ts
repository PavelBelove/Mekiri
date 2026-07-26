import path from "node:path";

import type { CanUseTool, HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { readAuditLog } from "mekiri-core";
import { computeTuningSignalContext } from "./tuningSignal.js";

// mekiri-host is only responsible for permissioning its own MCP tool(s) —
// the "mekiri" server registered by createMekiriTools (prune, sprout,
// harvest). Everything else (Bash, file edits, other MCP servers, etc.) is
// explicitly DENIED rather than falling through to any "default" handling.
//
// Supplying any canUseTool callback makes the SDK route every
// prompt-requiring tool decision through it (there is no partial opt-in) —
// but read-only tools like Read/Grep/Glob are auto-approved by the SDK's own
// default handling before they ever reach this callback (mirroring Claude
// Code's normal UX, where read-only operations don't prompt). This was
// confirmed by real dogfooding: reading a real file from this repo worked
// fine in live runs of this REPL both before and after this callback was
// added. Only tools that would normally need an approval prompt — Bash,
// Edit, Write, and any other MCP server's tools — actually reach here, and
// the SDK's own contract for CanUseTool is fail-closed: returning `null`
// means "the consumer already sent a control_response out-of-band," and if
// that's not true the tool stays blocked indefinitely with no error
// surfaced anywhere. This host does not do out-of-band responses, so `null`
// is never a safe return value here — it would silently reintroduce the
// exact hang this callback exists to fix, just without even a visible
// "needs your permission" message. Returning an explicit `deny` instead
// fails fast and visibly: the model sees the denial and can tell the user
// mekiri-host doesn't support interactive tool-permission prompts yet.
//
// Matching the "mcp__mekiri__" prefix rather than a fixed list of literal
// tool names keeps the allow side future-proof: any tool added to
// createMekiriTools later is auto-approved without another change here, and
// the prefix can't collide with other servers since the SDK's
// "mcp__<serverName>__<toolName>" naming ties it to the "mekiri" name we
// pass to createSdkMcpServer.
export const canUseTool: CanUseTool = async (toolName) => {
  if (toolName.startsWith("mcp__mekiri__")) {
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message:
      "mekiri-host is a minimal REPL that doesn't yet support interactive tool-permission prompts; only mekiri's own tools (mcp__mekiri__*) are auto-approved in this iteration.",
  };
};

// Layer 1 of the three-layer prompt split (see feedback-mekiri-prompt-layering
// memory): basic, stable rules that apply identically to the parent session
// and every sprout clone. Role-specific framing ("you are a clone...") stays
// in handleSprout's framedTask (layer 3) -- this text must never branch on
// role. English, matching every tool description in tools.ts, not the
// Russian skill-body content (layer 2).
export const MEKIRI_SYSTEM_PROMPT = `You are running inside mekiri-host, a minimal SDK-hosted REPL for the Mekiri
project -- a context-hygiene tool that lets you manage your own session
history directly, instead of relying only on automatic compaction.

In addition to your normal tools, you have four Mekiri-specific tools:
- prune(quote, note_type, fruit, keep_code) -- cut a dirty tail of this
  session and continue from a distilled note.
- sprout(task) -- fork a warm clone of this session to work a side task
  in isolation.
- harvest(result, needs_clean_look?) -- return a clone's result to its
  parent (only valid inside a sprout clone).
- configure_mekiri(patch, reason) -- patch Mekiri's own runtime config
  (.mekiri/config.json).

You also have two Mekiri-specific skills available: mekiri-gate and
mekiri-tuning. Check mekiri-gate before any non-trivial decision about how
to dispatch work -- prune, sprout, a clean subagent, or staying inline.
Check mekiri-tuning whenever the user states an explicit priority about
Mekiri's own behavior, or when reviewing .mekiri/audit.jsonl shows a
sustained signal. Do not skip these because a decision "feels obvious" --
that is exactly when the gate is easiest to skip and most useful to apply.

This host currently only auto-approves Mekiri's own tools and read-only
tools (Read/Grep/Glob); Bash, Edit, Write, and any other MCP tool are
denied.`;

// First-user-prompt hook: mekiri-tuning's Trigger B (see tuningSignal.ts)
// currently relies entirely on the agent remembering to check
// .mekiri/audit.jsonl. This closes that gap with live computation at the
// first prompt of every query() instance (parent and clone alike -- the
// audit log is shared) instead of duplicating MEKIRI_SYSTEM_PROMPT's static
// text, which is the one thing a static system prompt cannot do.
//
// Uses UserPromptSubmit, not SessionStart: SessionStart/SessionEnd hooks
// passed via Options.hooks are confirmed broken upstream as of SDK 0.3.218 /
// CLI 2.1.218 (anthropics/claude-agent-sdk-typescript#83) -- they are never
// invoked in a live session, verified by direct repro outside this
// codebase. UserPromptSubmit fires correctly in the same repro harness and
// supports the same additionalContext mechanism.
//
// The hasChecked flag makes this fire at most once per query() instance
// (constructed fresh inside buildQueryOptions(), not module-scope, so both
// the flag and dir are correctly scoped to one query() lifetime -- in
// repl.ts that spans one "session segment" until the next prune-triggered
// switch, which is close enough to "once per session" for this purpose).
// Without the flag this would recompute and re-inject on every single user
// message for the rest of the session, which is not the intent.
function createFirstPromptTuningSignalHook(dir: string): HookCallback {
  let hasChecked = false;
  return async () => {
    if (hasChecked) {
      return {};
    }
    hasChecked = true;
    const entries = await readAuditLog(dir);
    const additionalContext = computeTuningSignalContext(entries);
    if (additionalContext === undefined) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  };
}

// Formats a thrown query()/stream error (auth expiry, rate limit, network
// blip, etc.) into the message shown to the user when a live turn loop
// fails mid-session. Kept as a small pure function so the "don't crash,
// tell the user honestly, keep the session id, let them resume" behavior
// can be unit-tested without needing to trigger a real query() failure —
// those aren't reproducible deterministically in a fast test, and aren't
// worth the live API cost/flakiness to force.
export function formatQueryErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `mekiri-host: query error: ${detail}. Type your next message to try resuming this session, or Ctrl+C to exit.`;
}

// mekiri-gate/mekiri-tuning ship as a local SDK plugin bundled with
// mekiri-host itself, not with whatever project is being hosted (--dir) --
// they must be available regardless of which project mekiri-host points at.
// import.meta.dirname is this file's own directory (src/ in dev, dist/ after
// build); skills-plugin/ sits one level up from either.
const SKILLS_PLUGIN_PATH = path.join(import.meta.dirname, "..", "skills-plugin");

// Builds the exact options object passed to query() inside runRepl()/
// runClone(), split out so tests can assert on the real code path (that
// canUseTool is actually wired in) instead of only on the standalone
// canUseTool export.
export function buildQueryOptions(context: {
  resume: string | undefined;
  cwd: string;
  mcpServers: Options["mcpServers"];
}): Options {
  return {
    resume: context.resume,
    cwd: context.cwd,
    mcpServers: context.mcpServers,
    canUseTool,
    plugins: [{ type: "local", path: SKILLS_PLUGIN_PATH }],
    systemPrompt: MEKIRI_SYSTEM_PROMPT,
    hooks: { UserPromptSubmit: [{ hooks: [createFirstPromptTuningSignalHook(context.cwd)] }] },
  };
}
