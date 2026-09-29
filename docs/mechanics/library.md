# The library: a project's own memory, built as a byproduct

`prune` and `sprout` exist to manage an agent's context *within* a session — throw out what turned into garbage, fork off a clone without dragging the parent's whole history along. Every `prune` call, whether or not it cuts anything, also does something else: it writes an entry into an on-disk archive that outlives the session. Nothing extra had to be built for this to happen — the `fruit` a `prune` call was already writing for its own purpose is the same object the library is made of. This document is about that archive as a subsystem in its own right, not as an implementation detail of `prune`.

## Why it's worth treating separately

If context is the working definition of an agent's identity for the duration of a session (see [philosophy.md](../philosophy.md#where-identity-lives)), then `prune`/`sprout` give an agent, within one session, the ability to *forget* what it no longer needs and *recall* what it does. The library is what accumulates when that same act repeats, call after call, session after session, across a project's whole lifetime — free, automatic, with no separate indexing pass or maintenance job. What it buys, concretely:

- **Accumulated experience.** A decision, an invariant, a root cause worked out once doesn't have to be re-derived by the next session, or by a `sprout` clone picking the project back up cold.
- **Knowledge shared between sessions without a live handoff.** One session's finding is available to a session that starts days later, run by a different context, without either session having to have been open at the same time.
- **Cause and effect, not a bag of facts.** `report.md` preserves the reasoning chain that led to a conclusion, in the order it was written — not an atomized fact stripped of the argument that produced it (see [Why not RAG, why not Zettelkasten](#why-not-rag-why-not-zettelkasten) below).
- **Negative knowledge, kept instead of discarded.** Most memory schemes only capture what turned out true. `death_reload`'s `ruled_out` captures what was tried and shown *false* — the specific thing most valuable for breaking a future session's tendency to reconverge on the same dead end, and the thing that normally dies with the session that found it.
- **A literal snapshot of a past identity, not a summary of one.** `graft(rule_id)` doesn't return what a past session says it thought — it returns the actual transcript fragment, verbatim, as it was written at that moment: the reasoning, the request, the exact wording of an agreement made with the user. If context is what makes up an agent's identity for the duration of a session, this is the fullest form of long-term memory of that identity available on a text-only substrate — and notably not any of the usual candidates. Not a RAG chunk, which is selected for sounding relevant to a query, not for being the passage that actually mattered. Not the codebase, which shows what the code *is now*, carries no reasoning, and has usually moved on from the state a given decision was actually made against. Not a markdown note either, which is already somebody's summary — one step removed from the moment itself, and only as accurate as whoever wrote it managed to be. What `graft` returns is the original context state as it stood at the moment a decision was actually made, recoverable from any session in the project regardless of how long ago it ran or which agent ran it, for as long as Mekiri has been archiving that project (see [prune-and-graft.md](prune-and-graft.md#graft--reading-the-archive) for the durability mechanism this rests on).

## Three layers of abstraction

### Layer 1 — Navigation: `sessions-index.md` + `capsule.md`

The coarsest layer, and the cheapest to read. `.mekiri/sessions-index.md` is a one-line-per-session overview of the whole project — session folder name, session id, local time range, how many entries were cut vs. kept, a short summary of the first entry — cheap regardless of how old the project is, the entry point for deciding *which* past sessions are even worth looking at. It's a constantly-updated index, not a snapshot taken at some past point: every session appends its own line when it writes its first entry, so the file an agent reads is always current as of the last `prune` call anyone made on the project, including ones from minutes ago. Each session's own `capsule.md` is its table of contents: one line per `prune` call, `rule_id`, tagged `[kept]` / `[cut]` / `[kept+cut]`. Neither file holds the actual content — both exist purely so an agent (or a human) can decide where to look next without reading anything line by line.

### Layer 2 — Understanding: `report.md`

Where the actual distillate bodies live, one per `rule_id`, appended in the order they were written — a chronological, first-person record, not a shuffled index of facts. Because reasoning is naturally contiguous prose, `report.md` keeps it that way: an agent that knows a range from `capsule.md` reads exactly that range in one call, and gets back the argument, not just the conclusion. This is the layer where "what happened and why" actually lives, and for most warm-up needs, reading a range here is the whole job — see the `mekiri-warmup` skill.

Each entry in `report.md` also carries an `Activity:` line — a mechanical tally of `tool_use` calls (`Read×3, Edit×1(file.ts)`) computed straight from the transcript range that entry covers, independent of what the agent wrote in `kept_context`/`summary`. It's not a fourth layer so much as a factual floor under Layer 2: prose can be an honest but incomplete account of a range (a fact mentioned in a chat reply but never carried into the archived text is a real failure mode), and `activityLog` can't fix that, but it does guarantee that *what tools actually ran* survives the record regardless of how complete the narrative around them turned out to be. See [prune-and-graft.md](prune-and-graft.md#guaranteed-raw-range-continuity-and-a-mechanical-backstop-for-thin-prose) for the mechanism and the related `coverage_hint`.

### Layer 3 — Identity recovery: `graft`

The layer beneath the distillate. `graft(rule_id)` reaches past `report.md`'s summary into `.mekiri/capsule-index.jsonl` (a flat, project-wide, machine-only index — one line per `prune` call across every session, letting `graft` find the right session and byte range in a single lookup) and returns the *original* transcript fragment that call once covered — the request as it was actually phrased, the reasoning as it actually ran, wrapped in recovery metadata (`event`, `session`, `timestamp`). Not a second summary: the same words a past session actually generated, recoverable in one tool call, from any session in the project, at any point after the fact.

### The user's own prompts

The layers above record what the *agent* concluded. What the *user* asked is recorded separately: every user prompt, verbatim, with its attachments (images, documents), captured by `mekiri-proxy` off the wire. Each session's `capsule.md` gets a metadata-only line per prompt, interleaved with the `prune` entries in chronological order:

```
[user #7] 12:22 · 96 KB · 1 812 lines · log · interrupted · 2 attachments — graft("user#7")
[user #8] 12:25 · 64 B · speech — graft("user#8")
```

`kind` (`speech` / `log` / `code` / `mixed`) comes from a cheap classifier (gzip ratio, share of log-like and code-like lines), so a 96 KB pasted log is distinguishable from a 96 KB instruction without opening it. `interrupted` means the prompt came right after the user stopped the agent (or the connection dropped): it may carry a correction. The text itself is only reachable through `graft("user#7")`, `graft("user#7-10")`, or `graft("<sessionId>:user#7-10")` for a past session.

**The prompts never enter the project.** They live under `~/.mekiri-proxy/prompts/<sessionId>/` (directory `0700`, files `0600`), next to the shadow transcripts. Users paste API keys, tokens and personal data into prompts; `.mekiri/` is gitignored, but one mistake in one project would publish everything, so the project library holds only the metadata lines above.

The practical trigger for reaching this deep: a distillate is the agent's own summary of what happened and cannot self-certify that summary's accuracy. When something in `report.md` reads as insufficient — a decision whose exact wording matters, an agreement with the user that needs checking word-for-word, a suspicion that the summary was written before the underlying work was actually verified — `graft` is how that gets checked against what actually happened, instead of against what was later said to have happened.

## Why not RAG, why not Zettelkasten

The obvious candidates for "let an agent recall its own past" are retrieval over embeddings and atomic linked notes. Both are built for a different retrieval shape than the one that actually shows up here.

RAG returns nearest neighbors by semantic similarity — text that *sounds like* the query, not the specific passage that *caused* a given conclusion. A root cause is usually a chain: symptom, one or two false leads, the actual mechanism, the fix — and the sentence that states the mechanism doesn't necessarily share vocabulary with the sentence that asks about the symptom. Similarity search can easily surface a chunk that mentions the same error message without ever containing the explanation, because "reads similar" and "is the answer" are different relations, and only one of them is what's needed here.

Zettelkasten-style atomic notes (one idea per note, connected by links) are built for a human doing associative recall over years, holding the connective tissue between notes in their own head as they browse. An agent has none of that tissue at the start of a session — reconstructing "what happened and why" from a graph of atomic notes means a multi-hop walk, and each hop is a tool call that can pick the wrong edge or lose the thread, with no felt sense of "getting warmer" to correct course by.

Mekiri's archive is closer to a much older and more boring piece of engineering: a ship's log plus a card catalog. `report.md` is the log — append-only, chronological, written in the first person at the moment of full understanding, each entry a contiguous block rather than an atomized fact. `capsule.md` is the catalog card — it doesn't rank entries by similarity, it points at an exact address: this `rule_id` is this range of lines in this file, the way a library card gives a shelf and a page rather than a list of "related items" to go explore. Two consequences follow directly:

1. **Sequential meaning stays sequential.** The reasoning behind a decision is naturally contiguous prose; storing it as a contiguous block instead of chunking it for embedding means nothing has to be reassembled out of order at read time.
2. **Addressing beats searching.** An agent handed a start line and an end line reads exactly that range in one call, with no ambiguity about which neighbor to follow next — the opposite of a graph traversal or a top-k similarity guess.

`graft` is the layer beneath even the catalog: the primary source, for when the log entry itself needs checking against what actually happened rather than what was written down about it — full fidelity, no compression, addressed by `rule_id` rather than searched.

## The cost model: storage is free, the log pays for itself

The archive's storage cost is close to zero: it's a growing set of flat files on the machine's own disk, and for one agent's own project logs, disk space is not a resource anyone needs to budget against — there's no indexing pass, no embedding cost, no external service to pay for. The only real cost is the handful of tokens each `prune` call spends writing its `fruit` — and that cost is repaid in the same transaction, not eventually: the call that pays it is the same call that removes the far larger, recurring cost of carrying the pruned range into every subsequent request for the rest of the session (see [philosophy.md's tokenomics](../philosophy.md#tokenomics-not-savings-but-range)). Run across a project's whole lifetime, the result is a complete, chronological log of what every agent that ever worked on the project did and thought — built up as a side effect of sessions paying for their own hygiene anyway, not as a separate expense anyone has to justify on its own.

## The physical layout

```
.mekiri/
  sessions-index.md            # Layer 1 — human overview, one line per session
  capsule-index.jsonl          # machine-only, project-wide, one line per prune call
  sessions/
    <date>-<slug>/               # named after the session's first prune header
      .session-id               # the Claude Code session_id this folder belongs to
      capsule.md                # Layer 1 — this session's table of contents
      report.md                 # Layer 2 — this session's distillate bodies
    pending-<session_id>/        # a session with prompts recorded but no prune yet

~/.mekiri-proxy/                 # outside the project, per user
  raw-transcripts/<session_id>.jsonl   # shadow transcript -- graft(rule_id) reads this
  prompts/<session_id>/                # user prompts -- graft("user#N") reads this
    index.jsonl  001.md  001-1.png  ...
```

Folders are named by meaning, not by ID, so a human or an agent browsing the library sees what each session was about straight from `ls`; `session_id` (the Claude Code transcript ID) lives in each folder's `.session-id` marker and in `sessions-index.md`, and `rule_id` stays the address for `graft`. Human-facing times (`sessions-index.md`, folder dates, capsule `[user #N]` lines) are local; machine data (`capsule-index.jsonl`, `report.md` meta lines) is ISO UTC. See [prune-and-graft.md](prune-and-graft.md) for how `fruit` gets written in the first place, and the `mekiri-warmup` skill for the read path a session actually follows when it needs to use this.
