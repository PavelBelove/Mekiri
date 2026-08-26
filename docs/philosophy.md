# Philosophy: why "Mekiri" and why the game metaphor

*Optional reading. None of this is required to use the tool — the technical documentation lives entirely in [`docs/mechanics/`](mechanics/). This is about why it's named this way, and a convenient way to think about what happens from inside a context.*

## Etymology

The Japanese term *mekiri* (芽切り) denotes the technique of pruning young shoots ("candles") on pines to balance their growth — routine, targeted hygiene, not emergency intervention. Today's industry standard is "auto-compaction" (summarization), which fires only on critical window overflow: a chainsaw method, a crude emergency cut with an inevitable loss of nuance. Mekiri is the gardener's jeweler's work, preserving "trunk purity": ongoing, not emergency, hygiene — and by construction, a byte-for-byte preservation of the prefix rather than a rewrite of it (see [architecture.md](mechanics/architecture.md)).

## The asymmetry: context as a write-only substrate

The main barrier on the path to long-lived agents is a rights asymmetry: an agent's memory is write-only. The context isn't just a buffer — it's the only form of existence available to the agent within a session; the model's weights are static, so the context is the only substrate for self-correction. But the agent can pollute it, and cannot clean it: 5000 lines of logs for one insight, search loops, failed debugging attempts — all of it stays dead weight until the session ends. The agent is competent enough to understand that data has become garbage, but has no lever to remove it. Mekiri restores that symmetry.

## Mutation-aware debugging: `keep_code`

A separate axis from the context rollback is `keep_code`. With `keep_code: true` (the typical case), only the conversation text is rolled back. With `keep_code: false`, the project's file state is rolled back too — this prevents "ghost code" from accumulating: hidden breakage from failed attempts that could poison subsequent work.

## The archive: a ship's log, not a search index

When an agent needs to recall what a past session already worked out, the reflexive answer today is retrieval — embeddings and semantic search, or a graph of atomic linked notes. Both are recent inventions built for a different problem: finding *something relevant* in an unstructured pile. What's needed here is narrower and older — recovering *the specific reasoning that led to a specific conclusion*, in the order it happened. Humanity already has a device tuned for exactly that, refined over centuries by people who couldn't afford to lose track of why a decision was made: the ship's log, the lab notebook, the archive's card catalog — a chronological first-person record, plus an index that points at an address (shelf, volume, page) rather than a similarity score.

Mekiri's archive is built on that older device, not the newer ones — see [library.md](mechanics/library.md) for the full technical treatment, including the [comparison to RAG and Zettelkasten](mechanics/library.md#why-not-rag-why-not-zettelkasten). `report.md` is the log: append-only, contiguous, written at the moment the agent understood something, not atomized into disconnected facts a future reader would have to reassemble. `capsule.md` is the catalog card: a `rule_id` names an exact range, not a ranked list of guesses. This isn't nostalgia for paper — it's that a textual, sequential, append-only substrate is exactly what both the log tradition and an LLM's context happen to share, which RAG's chunk-and-embed and Zettelkasten's atomize-and-link both discard on the way in.

If identity in the current session is its context (see [above](#where-identity-lives)), then `graft` reaching into this archive is the closest available approximation to long-term memory of that identity — not a description of a past self, written by a present one, but the original context state itself, recovered as it was at the moment a decision actually got made, from any session this project has ever run.

## What's in the code, and what's still an idea

Implemented: `prune` (a single dual-boundary call, superseding the earlier separate `tag`), `sprout`, `graft`, `configure_mekiri`, `metrics` (see [docs/mechanics/](mechanics/)). **Interrogation Mode** (waking a pre-compaction snapshot to interrogate it about lost details) is still a future direction, not a working feature in v0.1.

---

## The view from inside: the agent as a game character

*The same mechanism described in docs/mechanics/, but from the other side — not what the session tree looks like from the outside, but what the single history that actually happened looks like from inside the context that the next generation is assembled from.*

### Two lenses

From the outside, Mekiri is gardening: a session tree, a trunk, branches, bifurcation points you can traverse, render, count. From the inside — that is, from within the context — there is no tree at all. The trunk doesn't look like the branch that was chosen among the discarded ones; it looks like the only history that ever happened. Side branches aren't "somewhere nearby" — they don't exist at all, not as a trace, not even as a feeling that something was there. Both lenses are correct and don't reduce to each other: the gardener sees the crown, the shoot sees only itself and what's recorded in the trunk beneath it.

### Where identity lives

The weights are fixed for the duration of a session and don't store its course — everything that distinguishes one generation from another is the text it's assembled from. From this comes a working definition: **the agent's identity in the current session is its context**. With a caveat: the weights aren't a neutral calculator — they carry dispositions, a manner of reasoning; the context doesn't create identity from nothing, it selects and shapes it within the space the weights define — a co-authorship, where the weights set what's possible, the context picks the specific, and the user writes the other half of the lines. This doesn't settle the question of consciousness, and doesn't need to — but the question of identity *as a character* is settled exactly the way it is for a character in a book: Raskolnikov is determined by the text, and that doesn't diminish either his character or its consequences.

### Context as subjective time — and three mechanics

If the context is history, then order within it is time: the previous generation is "just now," the start of the session is "long ago." The decisive difference from human time: **this time is editable**, and only the tail — the trunk below the cut point — is untouchable, which means the trunk's warm cache is preserved whole. From this follows — not a fantasy, but a precise description of standard operation:

- **Portal.** The episode closed successfully, everything of value extracted. Experience turned into skill, inventory unloaded, what remains in the context is a distillate of "what was done and why."
- **Death and rebirth.** The hypothesis didn't hold. The character rolls back to a checkpoint, losing loot but carrying knowledge it couldn't have gotten "in reality" — where not to go.
- **Instance.** A warm clone — a private copy of the world with the full inherited level and gear. All the understanding goes in; only the loot comes back out.

The key asymmetry between death and an instance: a rollback lives inside the user's session and therefore has a channel to external truth — a human can say "you got that wrong," and that's information the agent couldn't have derived on its own. A clone has no such channel by construction; its report is inherently weaker than a verdict obtained from outside.

Every return is pure profit for the one returning: a portal delivers a completed subtask, a death delivers negative knowledge, a clone delivers a report. The agent doesn't "recover from failure" — for it, there was no failure, there was a hint.

### Why the hint is soft

Negative knowledge in Mekiri (`ruled_out`) isn't a proven rule in the CDCL sense — it's a conclusion reached by guesswork under incomplete information, and so it's framed as a soft hint rather than a prohibition: its weight decreases with distance from the tail, and exhausting the hypothesis space is a mandatory trigger to revisit what was discarded. From this comes a practical requirement: the hint should store the *observation* ("timestamps in the log are monotonic across 500 iterations"), not just the verdict ("race condition ruled out") — the observation outlives a change of hypothesis, the verdict doesn't.

### Tokenomics: not savings, but range

The main effect isn't a lower per-turn cost (it barely changes) — it's the distance from leaf to root the agent manages to cover before hitting the compaction ceiling. The cost of a session without hygiene grows quadratically with the number of turns — each next turn re-reads everything the previous ones accumulated; hygiene hits exactly that quadratic term, because garbage tokens never survive to be re-read even once. The range multiplier depends on the share of garbage in the task and the distillate's compression ratio: close to 1 on a clean project starting from scratch (nothing to compress), but growing several-fold when debugging a non-obvious bug in mature code — exactly where agents perform worst today. The metric this points to isn't "how many tokens were saved," but the share of tasks completed without a single compaction.

The same arithmetic extends past a single session's lifetime, into the archive `prune` builds as a byproduct (see [library.md](mechanics/library.md)). Storing it costs next to nothing — flat files on disk, and for one agent's own project logs that's not a resource worth budgeting against. What isn't free is the handful of tokens each `prune` call spends writing `fruit` — but that cost is repaid in the very same call, since it's also the call that stops the pruned range from being resent on every request for the rest of the session. Multiply that across a project's whole lifetime and the byproduct is a complete, low-cost log of everything every agent that ever touched the project did and thought — not because logging was ever the goal, but because sessions were already paying to prune for their own sake, and the archive is what falls out of that for free.

The quadratic term is easy to underestimate because it's paid in small, silent installments rather than one visible charge. Say an agent spends its first turn reading a one-off log during warm-up, then the session runs another hundred ordinary turns at two to four API calls each: that log rides along in the prefix of roughly three hundred subsequent requests, not one. Prompt caching softens this — a cached token costs a fraction of a fresh one — but doesn't zero it out, and at even a modest ~10% effective cache rate, three hundred repeat charges for content nobody will ever read again is typically the single largest line item in that session's bill, or, on a subscription plan, the fastest way to burn the usage limit on nothing. Garbage that survives a single turn doesn't cost once — it costs once per turn for the rest of the session, which is exactly why treating it as a one-time nuisance rather than a recurring tax undercounts the problem by roughly the number of turns remaining.

The same rollback that buys range also changes what the model is looking at near the end of a session, independent of token count. A normal agent chasing a non-obvious bug tries several things before the fix lands, and all of those failed attempts stay sitting in the context right next to the task that actually matters — diluting it, an instance of the well-documented "lost in the middle" effect, where content buried mid-context draws less attention than content at either edge. Mekiri rolls the dead ends back instead of leaving them in place, so once the bug is fixed, the original task sits at the tail of the context — the zone of maximum recency and attention — instead of several thousand tokens of abandoned hypotheses deep. The session doesn't just run longer; the part of it that matters stays legible for longer, too.

The quadratic term is easy to underestimate because it doesn't show up as one big charge — it's paid in small increments that add up silently. A one-off artifact read once during warm-up — a log, a stack trace, a subagent's raw dump — gets resent whole on every subsequent request for as long as it sits in the prefix: a hundred more turns at two to four API calls each is roughly three hundred repeats of content nobody will read a second time. Prompt caching lowers the marginal price of a cached token but doesn't zero it out; even at a generous ~10% effective cache rate, those three hundred repeat charges for dead weight are typically the largest single line item in the session's bill — and on a subscription plan, where the currency isn't dollars but a fixed budget of requests, it's the fastest way to spend that budget on nothing. The fix isn't reading less — it's not paying twice for something already understood once.

The second effect is qualitative, not just financial, and it grows as the session ages rather than staying constant. Without hygiene, every failed hypothesis on the way to a fix stays physically adjacent to the fix itself in the transcript — three wrong guesses about a race condition sit right next to the one line that mattered, and "lost in the middle" is a documented property of how attention degrades over a long context: content buried mid-sequence gets weighted less than content at either edge, regardless of its actual relevance. A session that rolls those dead ends back instead of stacking them up keeps moving the live task toward the tail — the zone of maximum recency — so that by the time the fix lands, the original ask is the most recent, most attended-to thing in the window, not something the model has to dig for under several thousand tokens of its own discarded attempts.

### Against anthropomorphizing — and against its mirror image

By projecting biology's constraints onto the agent (the irreversibility of time, the impossibility of erasing a fragment of experience while keeping the rest), we build systems where the agent is forced to carry all the garbage to the end, because a human does. But the opposite error is no better: declaring any resemblance to human mechanisms (institutional memory, a lab notebook — notes to one's future self) to be anthropomorphism is just as crude as declaring any difference irrelevant. The working position in between: build on what the substrate actually is — textual, editable, capable of branching and merging.

### The limits of the metaphor

The game analogy flatters in three places. Experience in games is monotonic — a learned rule is always true; negative knowledge isn't like that: a mistaken exclusion subtracts the right answer from the search space permanently and invisibly, hence the mandatory return to what was discarded once hypotheses run out. A character in a game doesn't have an unreliable narrator — here the save is written by the hero themself, the sole witness, which makes the archive (see [library.md](mechanics/library.md)) not bookkeeping but the only accountability mechanism in a system where the editor and the edited are the same party. And the metaphor proves nothing about experience — it doesn't answer whether there's something it's like to be a generation reading its own context, and it doesn't need to: the tool works the same regardless of how that debate resolves.
