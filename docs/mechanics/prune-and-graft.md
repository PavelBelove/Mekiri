# prune, graft: rollback and memory across sessions

## `prune` — cut, archive, or both, in one call

```
prune(
  quote:      string,   # verbatim quote marking the boundary; "" means nothing to cut
  note_type:  "portal" | "death_reload",
  fruit:      { ... },  # schema depends on note_type, always includes kept_context
  keep_code:  bool      # true (typical case): project files are not rolled back; only applies when quote is non-empty
)
```

`quote` marks a dual boundary in the live transcript. Everything from the previous cut (or session start) up to `quote` is the **kept side**: it stays live in context, but its important parts are archived via `fruit.kept_context` so a future session, or this one after compaction, can recover them. Everything from `quote` to the current moment is the **cut side**: it is removed from what goes into the next request to the model, and replaced with a distillate built from the rest of `fruit`.

`quote` may be an empty string. That means there is nothing to cut this call: it becomes a pure archive call, recording `fruit.kept_context` without touching the live transcript at all. Critical: the note is written BEFORE the rollback, in the same call — it is a tool argument formulated at the moment of full understanding. After the rollback, that understanding is gone, and there is no one left to write it.

An `ok` response returns `{ rule_id, cut_effective_from: "next_request" }` — the turn already sent as this very response is not cut yet, only the next outgoing request from the same session will be (when `quote` was non-empty; a pure archive call never posts a cut at all). Other responses: `not_found | ambiguous | in_compacted_zone` (see [architecture.md](architecture.md#addressing-the-boundary-a-verbatim-quote)) — these only apply when `quote` is non-empty, since a pure archive call never searches the transcript for a boundary.

### `fruit.kept_context` — always present, sometimes empty

Every `fruit` object carries a `kept_context` field, required but allowed to be an empty string. It holds whatever from the kept side is worth surviving into the archive: a fact, an invariant, a decision that appeared in the trunk and is not a reason for a rollback right now, but would be worth pulling from a future session, or after this one compacts. Use it whenever such a fact appears, even on a call whose main purpose is a normal cut.

The only hard rule: `quote` and `kept_context` cannot both be empty in the same call — that combination cuts nothing and archives nothing, so validation rejects it outright.

### `note_type: portal` — the episode closed successfully

The branch voluntarily collapses into a fact. Fields, all required as keys but individually allowed to be empty when `quote` is empty (there is no cut side to describe):

- `summary` — what was done and why. Required non-empty when `quote` is non-empty.
- `files_touched` — list of changed files plus the gist of the edits. Required when `keep_code: true` (which, in turn, only applies when `quote` is non-empty): after the rollback, the agent does not see diffs and must know that its knowledge of these files is stale — on the next access, the file gets re-read rather than edited from memory of the old version.
- `gotchas` — pitfalls run into along the way.
- `kept_context` — see above.

### `note_type: death_reload` — the hypothesis did not pan out

Only makes sense when something is actually being cut, so `death_reload` requires a non-empty `quote`. A pure archive note (`quote: ""`) must use `note_type: portal` instead, even when what is being archived reads like a dead end.

- `tried` — what exactly was tried. Required non-empty.
- `ruled_out` — what is now excluded and why. Required non-empty. The one field that perturbs the model deterministic convergence toward the same dead end: the same ticket, the same code, the same system prompt will, with high probability, statistically converge on the same conclusion again — not because it "remembers" the path, but because it starts from the same priors. `ruled_out` is a fact deliberately written in to break that convergence.
- `facts_learned` — facts established along the way.
- `trigger` — `self_detected | user_feedback`. In practice, `death_reload` is triggered more often by direct negative user feedback ("you got it wrong, you broke X") than by internal reflection — that kind of `ruled_out` carries information the agent could not have derived on its own, and its value for perturbing convergence is higher.
- `kept_context` — see above.

### Nested rollbacks

The boundary of a later rollback can lie earlier than notes already written by previous small rollbacks on the same branch — in that case, one call "eats" several episodes at once, collapsing them into a single final note. This is a natural consequence of the fact that a rollback always cuts by a verbatim quote in the current transcript, not by the number of the previous rollback.

## `graft` — reading the archive

```
graft(
  target?: string  # rule_id of an entry from the table of contents in capsule.md of any session in this project
)
```

Works as a read from a flat on-disk archive, not from the live session — it survives compaction and session end by construction, not by luck.

- **Without `target`** — the table of contents (`capsule.md`) of only the current session: a list of `prune` entries with their `rule_id`, tagged `[kept]`, `[cut]`, or `[kept+cut]` depending on which sides that call touched, cheap regardless of the project age.
- **With `target = rule_id`** — searches the project-wide index (`.mekiri/capsule-index.jsonl`), which covers every session ever run in this project; finds the session, and returns the **raw transcript fragment** that call originally covered (verbatim, not the distillate) wrapped in recovery metadata (`event`, `session`, `timestamp`). Large fragments (raw ranges routinely run into the tens of thousands of characters) are hard-truncated with the real length reported alongside; entries written before raw-range recording existed, or whose session transcript file is no longer on disk, come back with an explicit status (`no_raw_range` / `transcript_unavailable`) rather than silently substituting the distillate or crashing.

Practical application: if, after a rollback, a past reply the agent expected to find is not in the context — that is almost always `prune` working as intended, not a glitch. Verify it via `graft`, not by rewriting from scratch: before claiming "that did not happen," first `graft(rule_id)` and read the actual original wording it returns, and only then draw a conclusion. This is deliberately not the distillate: a distillate is the agent's own summary of what happened and cannot self-certify that summary's accuracy — `graft` exists specifically to check a distillate (or a suspicion that one is wrong) against the real transcript underneath it.

## Where `fruit` physically goes

The note is not appended to the transcript as a service block — it goes to the on-disk archive (`.mekiri/sessions/<id>/report.md` + `capsule.md`, project-wide index `.mekiri/capsule-index.jsonl`). Its body has up to two labeled sections, one for the kept side and one for the cut side, matching whichever of `kept_context` and the cut-side fields were non-empty in that call. This distillate is a plain file on disk — reachable by reading `report.md` directly once you know a range from `capsule.md`/`capsule-index.jsonl` — separate from what `graft` itself returns (the raw fragment, not this body).

## The archive as the project library: speeding up future sessions warm-up

Every session leaves behind not just the history of its own rollbacks, but a contribution to the project shared memory: any `rule_id` written by `prune` in one session can have its raw fragment recovered via `graft(rule_id)` from any other session of the same project — without access to the live transcript, without re-running the whole chain of reasoning that led to that conclusion. For a new session, "warming up" — recovering the context built up by previous agents — usually means reading the ready-made distillate straight from `report.md`; `graft` is the extra step for when that summary needs checking against what actually happened.

Two entry points into this archive:

- **`.mekiri/sessions-index.md`** — a human-readable project overview, one line per session (alias, time range, number of cut and kept entries, the first entry as a short summary). The entry point for a human opening `.mekiri/` in an IDE, and for an agent that needs to understand what has been going on in the project before, without reading anything line by line.
- **`.mekiri/sessions/<date>-<slug>/`** — a human-readable alias (symlink) to the actual session folder `.mekiri/sessions/<session_id>/`, which holds its `capsule.md` (table of contents) and `report.md` (full entry bodies). The `session_id` itself is the Claude Code transcript ID and cannot be changed; the alias is a navigation wrapper on top of it, not a replacement for addressing.

In this picture, `.mekiri/capsule-index.jsonl` is not for humans: it is a flat machine index (one line per `prune` call across all sessions of the project), which `graft(rule_id)` uses to find the right session and range in `report.md` in a single operation, without scanning through every session in turn.
