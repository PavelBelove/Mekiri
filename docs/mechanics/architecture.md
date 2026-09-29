# Architecture: one primitive, two parameters

What looks from the outside like two different tools — `prune` and `sprout` — is conceptually one primitive with two independent settings:

```
spawn(transcript_slice, injected_message, kill_source: bool, timing: proactive | reactive)
```

- **`kill_source`** — is the source session destroyed (`prune`) or does it keep living in parallel (`sprout`).
- **`timing`** — is the operation invoked before the agent starts dirty work (proactively — it already knows it's about to get dirty), or after the mess has already piled up (reactively — after the fact).

| kill_source | timing | Scenario |
|---|---|---|
| yes | reactive | **Rollback.** The branch has already done its job, no reason to keep it alive. |
| no | proactive | **Warm clone.** The parent keeps working on the main task, the clone goes off to the side. |
| no | reactive | A rare edge case: the branch is polluted, but the parent needs to keep working on something in parallel in the old terminal for some reason while a new one starts from a clean slate. The mechanism doesn't forbid it. |
| yes | proactive | Not a separate case, just a deferred decision: "I know I'll get dirty, but I'll clean up later" — that's just a rollback triggered later, after the fact. |

From the agent's point of view, the result of both operations is structurally identical: a "new" continuation point, spawned from a distillate, with the context inherited down to the bit. The note on a rollback and the task on a fork are fields of the same object type, delivered into the tail.

## Why the implementation still differs

On Claude Code, these two values of `kill_source` are executed by two fundamentally different mechanisms — not for historical reasons, but because a rollback and a fork impose different requirements:

- **`kill_source: true` (rollback, `prune`)** doesn't need to spawn a new session — the branch being cut dies for good, so it's enough for *future* requests on this branch to no longer see it. Implemented as a rewrite at the HTTP proxy level: the source session file is never touched at all. `mekiri-proxy` is a local HTTP daemon started via `ANTHROPIC_BASE_URL`; every outgoing `/v1/messages` call goes through it. The `prune` tool registers a `{id, matchQuote}` rule in the daemon; on every next request from the same session, the daemon re-searches the current `messages[]` for the range to cut — by the quote text for the start of the range, and by the `rule_id` echoed back in `tool_result` for the end. The local session file and what the user sees in the UI never change — the rewrite exists only at the level of bytes going out to the API.
- **`kill_source: false` (warm clone, `sprout`)** has to leave the parent alive — which means the clone needs its own, honestly forked process with its own session id. Implemented as a headless subprocess: `claude --resume <sessionId> --fork-session -p "<task>" --output-format json`. The clone starts with the same `ANTHROPIC_BASE_URL`, so rollback rules already applied to the parent also apply to the clone's inherited context.

Consequence: a rollback has no "session tree" in the sense of files — there's a single session file for the parent's entire lifetime, whose history simply looks different on each successive API request.

## Addressing the boundary: a verbatim quote

The agent doesn't see internal message ids, but it does see its own text. The boundary is set by a verbatim quote — the first sentence of its own turn (8-10 words, compact and almost always unique), where the garbage starts. Retry protocol:

- Exact unique match → boundary found, cut inclusive.
- Zero matches → `not_found`, ask to copy verbatim.
- More than one → `ambiguous`, ask for a longer or different quote.
- Quote is in an already-compacted zone → `in_compacted_zone`. The stretch a mid-turn auto-compaction kept verbatim (on disk it sits *before* the summary; `compact_boundary`'s `compactMetadata.preservedMessages` marks it) counts as live, not compacted.

No "take the last occurrence" heuristics — a silent cut in the wrong place is worse than an explicit error.

Where a quote is looked for: the text blocks of messages first; only when the text has no match anywhere, the string inputs of tool calls (a Bash `description`, an `Edit`'s `new_string`), Mekiri's own calls excluded — every past `prune` carries its own quote. The fallback exists because Claude Code drops a text block written between two thinking blocks (thinking → text → thinking → tool_use) both from its `.jsonl` and from the history it resends, so such a sentence can't be found anywhere; the `not_found` hint says so and suggests quoting a tool call's description or the turn's final report instead. The on-disk check (`findBoundary`) and the wire-side cut share one matcher (`contentContainsQuote` in `mekiri-core`), so a quote `prune` accepted is always found when the cut is applied.

What is quotable: any finished tact (one API request), including earlier tacts of the sprint still running — Claude Code flushes each message to disk as it goes, so there is no need to wait for control to return to the user. Only the current tact is out of reach: the message holding the `prune` call itself, and any text written alongside it, has no on-disk form until the call returns. In a long autonomous sprint the natural quote is the `description` of the tool call that opened the finished episode. Dropping earlier assistant messages of the current tool loop (thinking blocks included) is accepted by the API; the cut is recomputed on every request, so `tool_use`/`tool_result` pairs stay whole.

User prompts inside a cut range are not lost. `rewriteMessages.ts` recognizes real prompts (the prompt log's classifier — hook and system texts don't count) among the messages being dropped and re-attaches them to the nearest kept user message before the range: the session's latest prompt verbatim, older ones as a short stub pointing to `graft("user#N")`. The agent never loses the request it is working on because its own `prune` swallowed it.

## Guaranteeing the tail: the `Stop` hook and `preserveFromQuote`

`quote` alone addresses where a cut *starts*; it says nothing about where it *ends* — that end is always the `prune` tool call's own position in the transcript (its `tool_use`/`tool_result` pair, matched by `rule_id`), since two calls could plausibly quote textually identical content and a text-based end would be ambiguous.

That's fine for an ordinary, agent-initiated `prune`: there's always at least a user message between "the report I just wrote" and "the `prune` call I'm now making", so the report never ends up inside the cut range by accident. A `Stop`-hook-forced `prune` (see [prune-and-graft.md](prune-and-graft.md#stop-forced-prune-guaranteeing-the-sessions-tail)) breaks that assumption: the hook fires *before* any new user message exists, so the just-written report and the forced `prune` call sit back-to-back with nothing between them — an end computed the ordinary way would swallow the report itself.

`bin/stop-hook.ts` handles this by writing a one-shot `stopBoundary` flag (`.mekiri/hook-state/<session_id>.json`: `{ lastAssistantMessage, setAt }`) before it blocks. The next `prune` call reads and consumes that flag, threading it into its rewrite rule as `preserveFromQuote`. `rewriteMessages.ts` then computes the cut's end as `min(anchorEnd, indexOfLastAssistantMessageContaining(preserveFromQuote))` — pulling the boundary back to just before the report regardless of how message merging happened to lay out that specific turn (a separate message vs. one merged with the `tool_use` block both resolve correctly, since the search is content-based, not structural). The flag is cleared after that one `prune` call, cutting or not — same one-shot consume-then-clear pattern as `nudge.deferCalls` in `nudgeHook.ts`.

A `stop_hook_active` loop guard (set by the platform on any turn that's already a forced Stop-continuation) prevents the hook from re-blocking a turn it already blocked. A `stopHook.enabled: false` kill-switch in `.mekiri/config.json` (default) fully disables the mechanism without touching `.claude/settings.json`.

## Interaction with auto-compaction

The compacted part of the context is already a distillate; rolling back "into" it is pointless (there's nothing to clean there) and technically dangerous (quotes from consumed turns won't be found). The rollback zone is only the raw turns after the last compaction. Auto-compaction isn't disabled: it stays as an emergency valve, rollbacks just demote it from routine to a rare event. With the opt-in context reset ([context-reset.md](context-reset.md)) the proxy handles the limit itself, and Claude Code's own compaction only fires if Mekiri is down.

## The daemon is one process per machine, by design

`mekiri-proxy`'s daemon is keyed only by port (`8791`), not by which project or clone's code started it — `daemonEnsure.ts` checks `/health` on that port and, if something already answers, reuses it instead of spawning. This is the intended steady state, not an accident to work around: one daemon per machine, serving every project on it, is how Mekiri is meant to run day to day. The project's own current dogfooding setup — a single daemon serving only this one repo — is the exception, not the norm; it looks that way only because this is currently the sole project using Mekiri on this machine.

The one situation actually worth watching for is two *clones of this same repo's source* both trying to serve that port (e.g. one mid-upgrade, one set up for a different purpose) — then whichever one's daemon wins the port first silently serves every project's requests with its own code, regardless of which clone a given project's `.mcp.json` points at, and `npm run typecheck` in the second clone won't catch this since it only checks local source. `/health` returns `pid` and `sourceDir` for exactly this reason: to let an agent confirm which clone's daemon is actually live, not just that something answered `ok`. If they don't match the clone you expect, kill that process and let the next Mekiri tool call respawn the daemon fresh from the right one.
