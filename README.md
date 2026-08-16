# Mekiri

**Context hygiene for AI agents: roll back garbage from the conversation history instead of carrying it to the end of the session.**

Mekiri (芽切り, "bud pruning") is an MCP tool for Claude Code. It gives an agent two primitives on top of a regular session: **`prune`** — a targeted rollback of part of the history, replaced with a short distillate, and **`sprout`** — a warm fork of the current context for parallel work. Both preserve the conversation prefix byte-for-byte, so the warmed cache is never lost.

## The problem

An agent's memory within a session is write-only. The context grows monotonically: 5000 lines of logs read to find one bug's cause, three failed hypotheses before the right one, a subagent's raw output pasted in whole instead of a summary — all of this stays dead weight until the end of the conversation. The agent perfectly well understands that a specific chunk of history has become garbage, but it has no lever to remove it.

The industry's standard answer is auto-compaction: an emergency summarization of the entire context when the window limit is approached. It works, but crudely — nuance is lost, and it fires because the window overflowed, not because a specific part of the conversation is already useless. The alternative — a clean subagent — solves the pollution problem at the cost of losing all accumulated understanding of the task: the subagent starts from zero and doesn't see what the parent has already figured out.

Between "tolerate the pollution" and "lose the whole context" there's a third path: remove exactly what became garbage from the history, leaving a short distillate in its place — and do this routinely, not only in an emergency.

## The solution

One primitive with two independent parameters (which branch dies, and when the operation is invoked) yields two tools:

- **`prune(quote, note_type, fruit, keep_code)`** — rolls back part of the history. The range from a verbatim quote to the current moment is cut from what goes into the next request to the model, and replaced with a distillate (`fruit`). Implemented at the level of an HTTP proxy between Claude Code and the Anthropic API — the local session file and the user interface are never touched, only what goes over the wire is rewritten.
- **`sprout(task, wait_mode)`** — a warm clone: an honest session fork (`claude --resume --fork-session`) that carries the entire current context along as an asset, without blocking the parent from continuing its main task.
- **`tag`** / **`graft`** — bookmark a valuable fact in the trunk without cutting anything, and read the archive of notes across sessions of the same project. The archive doubles as the project's library: `.mekiri/sessions-index.md` gives a human or agent a one-line-per-session overview of "what happened before," speeding up a new session's warm-up without re-reading old transcripts in full.
- **`configure_mekiri`** / **`metrics`** — tune behavior and built-in efficiency metrics (Distillation Ratio, Lifetime Token Savings, and more).

For a detailed architecture breakdown, see [docs/mechanics/architecture.md](docs/mechanics/architecture.md).

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

V 0.2. Implemented and used in the project's own day-to-day design (dogfooding): `prune`, `sprout`, `tag`, `graft`, `configure_mekiri`, `metrics`, `nudge-hook` (a forced reminder to use the tools). Not implemented (mentioned as a direction in [docs/philosophy.md](docs/philosophy.md)): `promote` (changing the leader of a session tree), Interrogation Mode, `sprout` with `wait_mode: "async"`.

## Installation

Mekiri is an MCP server + PostToolUse hook for Claude Code. Full turnkey instructions (including setup inside a third-party project, not just Mekiri itself) — [packages/mekiri-proxy/INSTALL.md](packages/mekiri-proxy/INSTALL.md).

```bash
git clone https://github.com/PavelBelove/Mekiri.git
cd Mekiri && npm install && npm run typecheck
```

## Mechanics in detail

- [architecture.md](docs/mechanics/architecture.md) — one primitive, two parameters; why `prune` and `sprout` are implemented differently
- [prune-and-graft.md](docs/mechanics/prune-and-graft.md) — rollback, `note_type: portal | death_reload`, `tag`, reading the archive via `graft`
- [sprout.md](docs/mechanics/sprout.md) — warm fork, limitations, the clone's right to self-escalate
- [gate.md](docs/mechanics/gate.md) — when to `prune`, when to `sprout`, when to use a clean subagent, when to just stay inline
- [tuning-and-metrics.md](docs/mechanics/tuning-and-metrics.md) — `configure_mekiri`, metric formulas, `nudge-hook`

## Philosophy

Where the name comes from and why the "portal / death-and-rebirth / instance" game metaphor is used to describe what happens to an agent from inside its context — optional reading in [docs/philosophy.md](docs/philosophy.md).

## License

MIT, see [LICENSE](LICENSE).
