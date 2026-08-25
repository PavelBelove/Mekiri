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

### Stop-forced `prune`: guaranteeing the session's tail

A typical agent sprint has a recognizable shape: **prompt → warm-up** (reading, research — may already get `prune`d mid-stretch if a sub-step closes on its own) **→ the actual work → self-check** (a build, a test run, a read-back to confirm the change landed — almost always one-shot garbage: what matters is confirming it passed, not carrying the exhaust forward) **→ the report to the user**. That report is one of the densest, most valuable fragments in the whole session — it's where plans for further work live, where reasons get explained, where agreements with the user get made explicit. Everything before it is either already cut or disposable; the report is the one part of the sprint that has to survive.

The archive only ever grows through `prune` calls (see [the archive as the project library](#the-archive-as-the-project-library) below). Whatever happens after the *last* `prune` a session ever makes is invisible to `graft` from any other session, permanently — if the session simply ends (the user closes the tab and never comes back) right after that report, it never gets indexed. This isn't just an archiving-completeness gap. A `prune`'s distillate captures *what was done* — the technical narrative of the closed episode. The report captures something a distillate doesn't: the agreement about *what happens next*. A future pickup — this same session after compaction, or a different session doing warm-up via `graft` — only ever sees the archive. If the report never made it in, that pickup has no way to know what the user actually asked for; it can only infer a plausible continuation from the distilled technical narrative, and left to guess, it will typically just keep extending that narrative. The result is an agent confidently solving a task adjacent to, but not actually, the one the user expects — because the user's half of the conversation, the part that lived only in the report, was never in the record it picked up from.

When enabled (`stopHook.enabled: true`), a `Stop` hook closes this gap structurally rather than relying on the agent to remember: it fires whenever a turn is about to end and control would return to the user, force-blocks that return, and requires a `prune` call before the turn can actually finish. This guarantees every session's final stretch gets indexed into the shared library — not just whatever the agent happened to `prune` on its own initiative.

Calling `prune` doesn't end the turn by itself — it only satisfies the block. The agent is free to write more after the tool call returns, and in practice that's exactly what should happen: the forced `prune` closes out whatever came before (the warm-up, the work, the self-check debris), and the actual report — the dense, valuable part — gets written right after it, in the same continuation. That report then becomes the transcript's newest last-assistant-message, so it's this text, not the pre-`prune` one, that `preserveFromQuote` is protecting when the *next* Stop event fires (see [architecture.md](architecture.md#guaranteeing-the-tail-the-stop-hook-and-preservefromquote)). A `stop_hook_active` guard prevents that next event from blocking again, so this second pass always reaches the user — one forced `prune`, then one real report, is the steady state, not a malfunction.

The end of a turn is, by construction, always a closed logical episode — the hook fires there whether or not there's actual garbage to cut. What that implies for the forced call differs by what closed:

- **Nothing to cut** — the turn's own conclusion (a decision reached, a fact established, a plan for what's next) is what's worth keeping, not discarding. `quote: ""`, everything worth surviving goes in `kept_context`. This is the common case for an ordinary "reported progress" turn in the middle of a larger task.
- **The turn's tail was self-check debris** — tests run to confirm a change, a verification read-back, a build/typecheck pass — real work already landed earlier in the turn, but the verification exhaust itself is one-off and doesn't need to survive. Ordinary `prune(portal)`: `quote` marks where the debris starts, `fruit.summary` names what was verified.
- **The whole turn (or more) was a finished side task** — e.g. a bug fix that came up mid-feature and got fully resolved within this turn. Since the whole thing is now a closed, no-longer-needed unit, `quote` can reach back past this turn's own start — same retroactive-compression case already covered in [gate.md's Question 4](gate.md#question-4-for-inline-work-once-its-done-is-the-side-episode-closed).

Whichever of these applies, the report just written for this turn — and the user's next prompt, once it arrives — are protected automatically regardless of where `quote` points: the daemon pulls the cut's actual end back to just before the just-finished assistant message rather than trusting `quote` for that (see `preserveFromQuote` in [architecture.md](architecture.md#addressing-the-boundary-a-verbatim-quote)). There's no need to manually word `quote` to avoid cutting the report — trying to would be redundant, and getting it wrong would be a mistake this mechanism exists specifically to make impossible.

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

## The archive as the project library

Every session leaves behind not just the history of its own rollbacks, but a contribution to the project's shared memory: any `rule_id` written by `prune` in one session can have its raw fragment recovered via `graft(rule_id)` from any other session of the same project — without access to the live transcript, without re-running the whole chain of reasoning that led to that conclusion. This archive — its three layers of navigation/understanding/recovery, why it's shaped like a ship's log and card catalog rather than RAG or a Zettelkasten, and the physical file layout on disk — is covered on its own terms in [library.md](library.md).
