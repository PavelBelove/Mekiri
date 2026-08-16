# prune, tag, graft: rollback and memory across sessions

## `prune` — rollback with distillation

```
prune(
  quote:      string,   # verbatim quote of the start of the first turn being discarded
  note_type:  "portal" | "death_reload",
  fruit:      { ... },  # schema depends on note_type
  keep_code:  bool      # true (typical case): project files are not rolled back
)
```

The range from `quote` to the current moment is cut from what goes into the next request to the model, and replaced with a distillate (`fruit`). Critical: the note is written BEFORE the rollback, in the same call — it's a tool argument formulated at the moment of full understanding. After the rollback, that understanding is gone, and there's no one left to write it.

An `ok` response returns `{ rule_id, cut_effective_from: "next_request" }` — the turn already sent as this very response isn't cut yet, only the next outgoing request from the same session will be. Other responses: `not_found | ambiguous | in_compacted_zone` (see [architecture.md](architecture.md#addressing-the-boundary-a-verbatim-quote)).

### `note_type: portal` — the episode closed successfully

The branch voluntarily collapses into a fact:

- `summary` — what was done and why (required).
- `files_touched` — list of changed files + the gist of the edits (required when `keep_code: true`): after the rollback, the agent doesn't see diffs and must know that its knowledge of these files is stale — on the next access, the file gets re-read rather than edited from memory of the old version.
- `gotchas` — pitfalls run into along the way.

### `note_type: death_reload` — the hypothesis didn't pan out

- `tried` — what exactly was tried.
- `ruled_out` — what's now excluded and why (required). The one field that perturbs the model's deterministic convergence toward the same dead end: the same ticket, the same code, the same system prompt will, with high probability, statistically converge on the same conclusion again — not because it "remembers" the path, but because it starts from the same priors. `ruled_out` is a fact deliberately written in to break that convergence.
- `facts_learned` — facts established along the way.
- `trigger` — `self_detected | user_feedback`. In practice, `death_reload` is triggered more often by direct negative user feedback ("you got it wrong, you broke X") than by internal reflection — that kind of `ruled_out` carries information the agent couldn't have derived on its own, and its value for perturbing convergence is higher.

### Nested rollbacks

The boundary of a later rollback can lie earlier than notes already written by previous small rollbacks on the same branch — in that case, one call "eats" several episodes at once, collapsing them into a single final note. This is a natural consequence of the fact that a rollback always cuts by a verbatim quote in the current transcript, not by the number of the previous rollback.

## `tag` — a bookmark without a cut

```
tag(
  quote: string,  # verbatim quote, same retry protocol as prune
  fruit: { summary, files_touched?, gotchas? }
)
```

Boundary addressing and the write to the on-disk archive happen the same way as with `prune`, but no rewrite rule is sent to the daemon — the marked range stays alive in the context. The point is to mark a section as valuable for understanding "for the future" (for future sessions of this project, not just the current one), so it can be found and pulled out via `graft` later, regardless of whether it survives in the live context until the end of the session or gets cut later by a regular `prune`.

Use `tag` when a fact, invariant, or decision appears in the trunk (without a cut) that isn't a reason for a rollback right now, but would be worth being able to pull from a future session or after this one compacts.

## `graft` — reading the archive

```
graft(
  target?: string  # rule_id of an entry from the table of contents in capsule.md of any session in this project
)
```

Works as a read from a flat on-disk archive, not from the live session — it survives compaction and session end by construction, not by luck.

- **Without `target`** — the table of contents (`capsule.md`) of only the current session: a list of `prune`/`tag` entries with their `rule_id`, cheap regardless of the project's age.
- **With `target = rule_id`** — searches the project-wide index (`.mekiri/capsule-index.jsonl`), which covers every session ever run in this project; finds the session and range, reads the entry's full body from that session's `report.md`, and returns it wrapped in recovery metadata (`event`, `session`, `timestamp`).

Practical application: if, after a rollback, a past reply the agent expected to find isn't in the context — that's almost always `prune` working as intended, not a glitch. Verify it via `graft`, not by rewriting from scratch: before claiming "that didn't happen," first `graft(rule_id)`, check against the original, and only then draw a conclusion.

## Where `fruit` physically goes

The note isn't appended to the transcript as a service block — it goes to the on-disk archive (`.mekiri/sessions/<id>/report.md` + `capsule.md`, project-wide index `.mekiri/capsule-index.jsonl`) and stays accessible via `graft` regardless of what happens to the branch itself afterward.

## The archive as the project's library: speeding up future sessions' warm-up

Every session leaves behind not just the history of its own rollbacks, but a contribution to the project's shared memory: any `rule_id` written by `prune`/`tag` in one session is readable via `graft(rule_id)` from any other session of the same project — without access to the original transcript, without re-running the whole chain of reasoning that led to that conclusion. For a new session, this means "warming up" — recovering the context built up by previous agents — costs not hundreds of thousands of tokens of transcript, but a single targeted `graft` on an already-known `rule_id`, or reading a ready-made summary.

Two entry points into this archive:

- **`.mekiri/sessions-index.md`** — a human-readable project overview, one line per session (alias, time range, number of `prune`/`tag` entries, the first entry as a short summary). The entry point for a human opening `.mekiri/` in an IDE, and for an agent that needs to understand what's been going on in the project before, without reading anything line by line.
- **`.mekiri/sessions/<date>-<slug>/`** — a human-readable alias (symlink) to the actual session folder `.mekiri/sessions/<session_id>/`, which holds its `capsule.md` (table of contents) and `report.md` (full entry bodies). The `session_id` itself is the Claude Code transcript ID and can't be changed; the alias is a navigation wrapper on top of it, not a replacement for addressing.

In this picture, `.mekiri/capsule-index.jsonl` isn't for humans: it's a flat machine index (one line per `prune`/`tag` across all sessions of the project), which `graft(rule_id)` uses to find the right session and range in `report.md` in a single operation, without scanning through every session in turn.
