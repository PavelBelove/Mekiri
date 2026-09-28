# Context reset — design spec (stage 2: the library replaces auto-compaction)

Status: draft, agreed in discussion with the owner on 2026-09-28; implementation starts after stage 1 ([prompt log](2026-09-28-prompt-log.md)) is live and verified. This file records every decision from that discussion so none gets lost while stage 1 is being built.

## Why

Claude Code's auto-compaction is harmful once Mekiri is running:

- **It's expensive.** It makes the model summarize the whole context in an extra call, and the cache misses afterwards anyway.
- **It destroys navigation.** The summary drops the `rule_id`s of earlier prunes. The agent no longer knows what it archived and can't `graft` it.
- **It duplicates work already done.** A Mekiri session is already summarized and indexed: `capsule.md` is a table of contents, `report.md` holds the distillates, the shadow archive holds the raw transcript. A fresh agent with that library can pick what to read, instead of getting one unstructured summary.

So instead of compacting, Mekiri resets: near the limit, the proxy drops the middle of the conversation mechanically, keeps the tail, and tells the agent to warm itself up from the library.

## Agreed decisions

### 1. The reset is mechanical, done by the proxy

- No `quote`, no cooperation from the agent: nobody is there to write one at the moment of overflow. The proxy counts from the tail of the wire `messages[]`.
- No handoff `prune` before the reset. The not-yet-archived stretch is not lost: the recent part of it stays in the context verbatim (the kept tail), and the rest gets an `[auto-reset]` record (point 5).
- Claude Code keeps sending its full history on every request; it doesn't know about the reset. The reset is therefore stored as a persistent rule, like a `prune` cut, and applied to every subsequent request. A later reset moves the boundary forward. It composes with existing `prune` rules and reuses the `rewriteMessages` machinery.
- Side requests share the session id (the auto-mode classifier sends its own short request with a `<transcript>` of the conversation; found in stage 1). Size checks, cut selection and injection apply only to requests the shadow archive accepts as the main thread (`appendNewShadowMessages` returns `true`).
- Since the proxy sends a smaller context, the `usage` Claude Code sees is smaller too, which by itself keeps native auto-compaction from firing (already confirmed for `prune`).

### 2. When it fires

- The proxy checks the size of the **outgoing** request before sending it. Relying on the previous response's `usage` is not enough: one huge read (a 500-line log) can jump past the threshold within a single turn.
- Token estimate: to be decided at implementation time — a cheap local estimate (bytes/chars-based) versus the `count_tokens` endpoint (exact, but an extra round trip on every request). A local estimate with a safety margin is the default candidate.
- Threshold: Mekiri's reset fires where Claude Code's auto-compaction fires today. That threshold is set well below the context window, for efficiency and token economics, not because the window is full. Configurable via `.mekiri/config.json`.
- Native auto-compaction stays only as insurance for when Mekiri itself is down, pushed well beyond Mekiri's threshold. The expected knob is `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; verify it exists in the current Claude Code version before relying on it.

### 3. Where to cut

- Prefix (system prompt, tools, everything before the first message) stays byte-for-byte, so it stays cached. The message cache is lost, as with compaction, but without paying for a summarizing call.
- Preferred cut: **right after the last `prune`** — then everything cut is already indexed in the library. Used when the tail from that point fits the tail budget.
- Otherwise: the last K = 4 turns, capped at ~20k tokens. A turn is the unit, not a message. Never split a `tool_use` from its `tool_result`.
- Murphy's law applies: overflows are most likely right after a huge read, before the agent had a chance to `prune` it. That's exactly the case the fallback and the `[auto-reset]` record exist for.

### 4. What the new context contains

In order, after the untouched prefix:

1. An injected instruction: the token limit was reached and the context was reset; here is the capsule of the current session; first warm up using the `mekiri-warmup` skill, then continue.
2. The current session's `capsule.md`, inline. It's small (a line per entry), and saves a round trip. `report.md` and the shadow archive stay on demand via `graft`. Thanks to stage 1, the capsule includes the `[user #N]` lines too.
3. **The last user prompt, verbatim, always**, with its attachments, even when it lies outside the kept tail. It holds the instructions and the agreement for the current sprint — what the agent was doing at that moment. Without it the agent can forget five of seven bugs and report "done".
4. The kept tail, verbatim.

The first prompt of the session is not special: the session's topic often drifts (this very session started as a status review). Earlier prompts are reachable through the capsule and `graft("user#N-M")`. If the last prompt is just "continue", the agent looks further back that way.

### 5. Nothing gets lost: the `[auto-reset]` record

The stretch between the last `prune` and the start of the kept tail is in neither the library nor the new context. At reset time the proxy writes a mechanical entry into the library: capsule line `[auto-reset]`, `capsule-index.jsonl` entry with `rawStartLine`/`rawEndLine` into the shadow archive, activity log of the tool calls in that range. `graft` can then open it like any other entry. This keeps the "nothing is lost" guarantee without any cooperation from the agent.

The proxy knows the project directory from `rules.json` (`{sessionId: {dir, …}}`), which the MCP server fills on the first `prune`. If there's no `dir` yet (no `prune` in this session at all), the reset still happens, but the record and the inline capsule are skipped; the instruction then points the agent at the shadow archive via `graft` without a target.

### 6. Empty prunes stay

Empty `prune` calls (`quote: ""`) forced by the Stop hook are not garbage: they are continuity markers that keep the report sequential and guarantee every turn is archived. The nudge-hook stops counting them as idle (implemented in stage 1).

### 7. Distribution

Mekiri is a working tool for other people's projects; this project, where the agent is both the developer and the user, is the exception. Installation is: the user gives their agent a link to the repo; the agent gives a "tour" (what it is, why it helps, would it want this tool for itself) and, with the user's consent, configures everything itself. npm is not suitable: installation touches more than packages. This already works and has been tested on another project.

For this feature that means:

- defaults must work out of the box, with no tuning;
- pushing native auto-compaction back is a step in `AGENT-SELF-SETUP-GUIDE.md` / `INSTALL.md` that the installing agent performs, and the "tour" explains why;
- nothing in the setup may assume this machine or this repo.

## Tests

- Cut selection: after the last `prune` when the tail fits; K-turn fallback; token cap; never splitting `tool_use`/`tool_result`; a giant single tool result at the tail.
- Persistence: the reset rule applies to every later request; a second reset moves the boundary; composition with existing `prune` cuts.
- Injected context: prefix byte-identical, instruction + capsule + last prompt (with attachments) + tail in that order; the last prompt included even when outside the tail.
- `[auto-reset]` record: correct raw range, `graft` returns it; the no-`dir` case.
- Threshold check on the outgoing request, not on the previous `usage`.

## Live verification: the "self-warmup" test

Lower the threshold for a test session (a `configure_mekiri` patch, or a manual trigger), let a real reset happen mid-task, and watch whether the agent:

1. notices the reset and runs `mekiri-warmup` before doing anything else;
2. recovers the current sprint from the last prompt and the capsule, reaching earlier prompts via `graft("user#N-M")` when needed;
3. continues the task where it stopped, without redoing finished work or dropping unfinished items;
4. can `graft` the `[auto-reset]` range if it needs something from it.

## Docs

- `docs/mechanics/`: a new section (or file) on the reset: why it replaces compaction, the cut rules, the injected context, the `[auto-reset]` record.
- `README.md` status list.
- `AGENT-SELF-SETUP-GUIDE.md` / `INSTALL.md`: the auto-compaction override step, explained in the tour.

## Open questions

- Exact default threshold, and Claude Code's current auto-compaction point to align it with.
- Token estimation method (local estimate vs `count_tokens`).
- Whether `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is still the right knob, and what value to use for the insurance.
- The injected instruction's exact wording: it has to make a fresh agent warm up first without making it redo work.
