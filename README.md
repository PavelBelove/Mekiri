# Mekiri

**Context hygiene for AI agents, within a session and across them: roll back garbage instead of carrying it to the end, and hand off what a session learned instead of losing it when the session ends.**

Mekiri (芽切り, "bud pruning") is an MCP tool for Claude Code. It started as two primitives on top of a regular session — **`prune`** (a targeted rollback of part of the history, replaced with a short distillate) and **`sprout`** (a warm fork of the current context for parallel work) — and has grown into a full context-hygiene system: those two live primitives, plus **`graft`**, a project-wide library that every `prune` call feeds automatically, so what one session worked out doesn't have to be re-derived by the next one. All three preserve the conversation prefix byte-for-byte, so the warmed cache is never lost.

## The problem

An agent's memory within a session is write-only. The context grows monotonically: 5000 lines of logs read to find one bug's cause, three failed hypotheses before the right one, a subagent's raw output pasted in whole instead of a summary — all of this stays dead weight until the end of the conversation. The agent perfectly well understands that a specific chunk of history has become garbage, but it has no lever to remove it.

The industry's standard answer is auto-compaction: an emergency summarization of the entire context when the window limit is approached. It works, but crudely — nuance is lost, and it fires because the window overflowed, not because a specific part of the conversation is already useless. The alternative — a clean subagent — solves the pollution problem at the cost of losing all accumulated understanding of the task: the subagent starts from zero and doesn't see what the parent has already figured out.

Between "tolerate the pollution" and "lose the whole context" there's a third path: remove exactly what became garbage from the history, leaving a short distillate in its place — and do this routinely, not only in an emergency.

The cost of not doing this compounds silently, not just once. Say an agent spends its first turn reading a one-off log during warm-up, and the session then runs another 100 turns of ordinary work at 2-4 API calls each — that log gets sent back to the model roughly 300 times, not once, because every request resends the full prefix. Prompt caching cuts the price of a cached token to a fraction of a fresh one, but doesn't zero it out: at even a ~10% cache rate, 300 repeat charges for content nobody will read again is still typically the single largest line item in that session's bill — or, on a subscription plan, the fastest way to burn the usage limit on nothing.

## The solution

One primitive with two independent parameters (which branch dies, and when the operation is invoked) yields two tools, plus a third that both feed automatically:

- **`prune(quote, note_type, fruit, keep_code)`** — rolls back part of the history. The range from a verbatim quote to the current moment is cut from what goes into the next request to the model, and replaced with a distillate (`fruit`). Implemented at the level of an HTTP proxy between Claude Code and the Anthropic API — the local session file and the user interface are never touched, only what goes over the wire is rewritten. `quote: ""` turns the same call into a pure archive note, without cutting anything.
- **`sprout(task, wait_mode)`** — a warm clone: an honest session fork (`claude --resume --fork-session`) that carries the entire current context along as an asset, without blocking the parent from continuing its main task.
- **`graft`** — reads the library every `prune` call writes to, whether or not it cut anything. `graft()` lists the current session's own archive; `graft(rule_id)` recovers the verbatim raw transcript fragment behind any past entry, in any session of the project — not just the distillate, so an agent can check a summary against what actually happened.
- **`configure_mekiri`** / **`metrics`** — tune behavior and built-in efficiency metrics (Distillation Ratio, Lifetime Token Savings, and more).

For a detailed architecture breakdown, see [docs/mechanics/architecture.md](docs/mechanics/architecture.md).

## The library: a memory that builds itself

`prune` and `sprout` are about managing a single session's context — this is a separate payoff, not a detail of how those tools work. If context is what makes up an agent's identity for the duration of a session, `prune`/`sprout` give it the ability to forget what it no longer needs and recall what it does — *within* that one session. Every `prune` call, whether or not it cuts anything, also writes an entry into an on-disk archive that outlives the session — free, automatic, no separate indexing step. Run across a project's whole lifetime, that adds up to something a single session's hygiene can't: accumulated experience carried forward instead of re-derived, knowledge shared between sessions and agents with no live handoff required, the *reasoning* behind a decision preserved and not just its conclusion, and — the thing most memory schemes drop entirely — negative knowledge: what was tried and shown false, not just what turned out true.

Three layers of abstraction, each cheaper to read than the one below it:

- **Navigation** (`sessions-index.md`, `capsule.md`) — a one-line-per-session overview, then a table of contents per session. Where to look, without reading anything line by line.
- **Understanding** (`report.md`) — the actual distillate bodies, append-only and chronological, so the reasoning behind a decision reads as the contiguous argument it was, not a shuffled bag of facts.
- **Identity recovery** (`graft`) — not a summary of what a past session thought, but the literal transcript fragment as it was actually written: the exact reasoning, the exact request, the exact wording of an agreement made with the user, recoverable from any session in the project in a single call.

Full writeup, including why this is shaped like a ship's log and a card catalog rather than RAG or a Zettelkasten, in [docs/mechanics/library.md](docs/mechanics/library.md).

## What changes over a session's life

Three effects compound as a session runs long, only the first of which is about tokens:

- **More runway before compaction.** A session's cost without hygiene grows roughly quadratically with turn count — every turn re-reads everything the previous ones accumulated. Hygiene removes exactly the part of that growth that's garbage, so the number of agent turns a session can cover before hitting the compaction ceiling ("effective mileage") goes up — often several-fold on debugging and point-fix tasks, which is exactly where that ceiling bites hardest today.
- **The main task stays legible mid-context.** A normal agent chasing a bug tries several things before the fix lands, and all of those attempts stay sitting in the context right next to the actual task — diluting it, the well-documented "lost in the middle" effect where content buried mid-context draws less attention than content at either edge. Mekiri rolls the failed attempts back instead of leaving them in place, so once the bug is actually fixed, the original task sits at the tail of the context — the zone of maximum recency and attention — instead of several thousand tokens of dead ends deep.
- **The next session doesn't start from zero.** Every `prune` call also feeds the project's library (see above) — a decision, an invariant, or a root cause found once doesn't need re-deriving by a fresh session or a sprout clone picking the project back up later.
- **Hitting the limit stops being a loss.** When a session does reach the window limit, Mekiri can replace Claude Code's auto-compaction (opt-in): the proxy drops the middle of the conversation mechanically, keeps the tail and the user's last prompt verbatim, and the agent warms itself back up from the session's own library — no extra summarization call, no lost `rule_id`s. See [context-reset.md](docs/mechanics/context-reset.md).

## Example

An agent reads a 500-line log to find the cause of one test failure. The cause is found — the log lines themselves are no longer needed:

```
prune(
  quote: "Reading ci-run-4471.log to find the cause of...",
  note_type: "portal",
  fruit: {
    summary: "Test failed due to a race in setupFixtures — the fixture was read before it was written. Cause: missing await.",
    files_touched: [{ path: "test/fixtures.ts", change: "added await before setupFixtures()" }]
  },
  keep_code: true
)
```

The next request to the model from this session no longer contains the 500 log lines — just the short fact instead. The conversation in the UI and the session file on disk stay unchanged: the rule only applies to what goes over the wire.

## Status

V 0.3. Implemented and used in the project's own day-to-day design (dogfooding): `prune` (a single dual-boundary call, superseding the earlier separate `tag`), `sprout`, `graft`, `configure_mekiri`, `metrics`, `nudge-hook` (a forced reminder to use the tools), `Stop`-hook-forced `prune` (guarantees a session's final stretch always gets indexed into the archive, even if the agent never calls `prune` again on its own — see [architecture.md](docs/mechanics/architecture.md#guaranteeing-the-tail-the-stop-hook-and-preservefromquote)), the user prompt log (`graft("user#N-M")`, kept outside the project — see [library.md](docs/mechanics/library.md)), and the context reset that replaces Claude Code's auto-compaction (opt-in per project — see [context-reset.md](docs/mechanics/context-reset.md)). Not implemented: `sprout` with `wait_mode: "async"`.

## Installation

Mekiri is an MCP server + PostToolUse/Stop hooks for Claude Code.

### Self-hosting Mekiri on itself

Cloning this repo and opening Claude Code in it needs no file edits — `.mcp.json`, `.claude/settings.json`, `CLAUDE.md`, and `.claude/skills/*` already ship correctly configured for self-hosting.

```bash
git clone https://github.com/PavelBelove/Mekiri.git
cd Mekiri && npm install
npm run typecheck && npm run test --workspaces
```

Then set `ANTHROPIC_BASE_URL=http://127.0.0.1:8791` in the environment Claude Code actually starts from — a shell rc file for a terminal launch, or (for a GUI/IDE launch, where shell rc files aren't sourced) a systemd user-environment drop-in on Linux; see [INSTALL.md §3](packages/mekiri-proxy/INSTALL.md#3-anthropic_base_url) for the exact recipe — and **restart the whole Claude Code session**: the env var, `.mcp.json`, the hook, and the skills are all read once at process startup.

Verify: `curl http://127.0.0.1:8791/health` should return `{"status":"ok",...}`, and the `mekiri-gate` skill should show up in your available skills.

### Wiring Mekiri into a different project

Full turnkey instructions — [packages/mekiri-proxy/INSTALL.md](packages/mekiri-proxy/INSTALL.md).

## Mechanics in detail

- [architecture.md](docs/mechanics/architecture.md) — one primitive, two parameters; why `prune` and `sprout` are implemented differently
- [prune-and-graft.md](docs/mechanics/prune-and-graft.md) — rollback, `note_type: portal | death_reload`, where `fruit` goes
- [library.md](docs/mechanics/library.md) — the project-wide archive on its own terms: three layers, why it's a ship's log and card catalog, not RAG or a Zettelkasten
- [sprout.md](docs/mechanics/sprout.md) — warm fork, limitations, the clone's right to self-escalate
- [gate.md](docs/mechanics/gate.md) — when to `prune`, when to `sprout`, when to use a clean subagent, when to just stay inline
- [context-reset.md](docs/mechanics/context-reset.md) — near the window limit, drop the middle mechanically and warm up from the library instead of auto-compacting
- [tuning-and-metrics.md](docs/mechanics/tuning-and-metrics.md) — `configure_mekiri`, metric formulas, `nudge-hook`

## Philosophy

Where the name comes from and why the "portal / death-and-rebirth / instance" game metaphor is used to describe what happens to an agent from inside its context — optional reading in [docs/philosophy.md](docs/philosophy.md).

## Support the project

Mekiri is MIT-licensed with no strings attached — this section is a request, not a condition. It's a side project with no marketing budget, built and maintained for free. If it's useful to you, a star on GitHub, a mention in your team's chat, or a share on social media costs you nothing and genuinely helps it reach the next person it'd help too.

## License

MIT, see [LICENSE](LICENSE).
