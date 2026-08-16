# Philosophy: why "Mekiri" and why the game metaphor

*Optional reading. None of this is required to use the tool — the technical documentation lives entirely in [`docs/mechanics/`](mechanics/). This is about why it's named this way, and a convenient way to think about what happens from inside a context.*

## Etymology

The Japanese term *mekiri* (芽切り) denotes the technique of pruning young shoots ("candles") on pines to balance their growth — routine, targeted hygiene, not emergency intervention. Today's industry standard is "auto-compaction" (summarization), which fires only on critical window overflow: a chainsaw method, a crude emergency cut with an inevitable loss of nuance. Mekiri is the gardener's jeweler's work, preserving "trunk purity": ongoing, not emergency, hygiene — and by construction, a byte-for-byte preservation of the prefix rather than a rewrite of it (see [architecture.md](mechanics/architecture.md)).

## The asymmetry: context as a write-only substrate

The main barrier on the path to long-lived agents is a rights asymmetry: an agent's memory is write-only. The context isn't just a buffer — it's the only form of existence available to the agent within a session; the model's weights are static, so the context is the only substrate for self-correction. But the agent can pollute it, and cannot clean it: 5000 lines of logs for one insight, search loops, failed debugging attempts — all of it stays dead weight until the session ends. The agent is competent enough to understand that data has become garbage, but has no lever to remove it. Mekiri restores that symmetry.

## Mutation-aware debugging: `keep_code`

A separate axis from the context rollback is `keep_code`. With `keep_code: true` (the typical case), only the conversation text is rolled back. With `keep_code: false`, the project's file state is rolled back too — this prevents "ghost code" from accumulating: hidden breakage from failed attempts that could poison subsequent work.

## What's in the code, and what's still an idea

Implemented: `prune`, `sprout`, `tag`, `graft`, `configure_mekiri`, `metrics` (see [docs/mechanics/](mechanics/)). An idea mentioned in early design docs but not implemented in code — **`promote`** ("leader change"): a scenario where a child fork that has accumulated more value than its fading parent becomes the new trunk, and the original is marked superseded. Same status for **Interrogation Mode** (waking a pre-compaction snapshot to interrogate it about lost details) — a future direction, not a working feature in v0.1.

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

### Against anthropomorphizing — and against its mirror image

By projecting biology's constraints onto the agent (the irreversibility of time, the impossibility of erasing a fragment of experience while keeping the rest), we build systems where the agent is forced to carry all the garbage to the end, because a human does. But the opposite error is no better: declaring any resemblance to human mechanisms (institutional memory, a lab notebook — notes to one's future self) to be anthropomorphism is just as crude as declaring any difference irrelevant. The working position in between: build on what the substrate actually is — textual, editable, capable of branching and merging.

### The limits of the metaphor

The game analogy flatters in three places. Experience in games is monotonic — a learned rule is always true; negative knowledge isn't like that: a mistaken exclusion subtracts the right answer from the search space permanently and invisibly, hence the mandatory return to what was discarded once hypotheses run out. A character in a game doesn't have an unreliable narrator — here the save is written by the hero themself, the sole witness, which makes the archive (see [prune-and-graft.md](mechanics/prune-and-graft.md)) not bookkeeping but the only accountability mechanism in a system where the editor and the edited are the same party. And the metaphor proves nothing about experience — it doesn't answer whether there's something it's like to be a generation reading its own context, and it doesn't need to: the tool works the same regardless of how that debate resolves.
