# Gate: prune / sprout / clean subagent / inline

Models calibrate off contrasting boundary examples better than off paragraphs of criteria. Three questions in order, before choosing a dispatch tool:

## Question 1: is the task dispatchable at all?

If the work will need user intervention, course correction, or can't be stated in a single pass — neither a clone nor a clean subagent will work, regardless of asset/ballast. The point of a fork is isolation plus a single report at the end; that's incompatible with needing to keep a hand on the wheel. Work like that stays inline, in the main thread.

## Question 2 (if yes): is the inherited context right now an asset or ballast?

- Asset, you need the result rather than the process → a warm clone (`sprout`).
- Ballast or a source of bias → a clean subagent, without inheriting the current context.

## Question 3 (for a clone, while it's working): does the context remain an asset?

If signs of getting stuck show up inside the clone (the same dead ends that trigger `death_reload`) — the clone has the right to self-escalate: call a clean subagent within itself for a narrow question, or return the parent a recommendation instead of a success report (more detail in [sprout.md](sprout.md#a-clones-right-to-self-escalate)).

## Question 4 (for inline work, once it's done): is the side episode closed?

A "no" answer to Question 1 doesn't mean the mess stays forever — it only means a clone/subagent wasn't a fit *at the start*. If, over the course of inline work, it becomes clear that part of it was actually a side episode (fixing a bug inside feature work, rather than the feature itself), and that episode is done with a result — close it with the same `prune(portal)` after the fact, even if there was no real "clone or inline" choice at the start.

## Contrasting examples

| Situation | Tool |
|---|---|
| "Read 1000 lines of logs, cause found, logs no longer needed" | `prune(portal)` |
| "The serialization hypothesis didn't pan out, three attempts wasted" | `prune(death_reload)` |
| "No, you got it wrong, you broke X" — user feedback in a live session | `prune(death_reload, trigger: user_feedback)`, not an attempt to patch over broken understanding |
| "Deal with this bug while I keep working on the feature" — needs all the current understanding | `sprout` |
| "Go check the docs, find this API's call format" — parent's experience isn't needed | a clean subagent |
| Clone has been confidently wrong about a hypothesis for hours | clone self-escalation (Question 3) or a clean subagent from the start |
| "Fix it, but I want to see every step and decide where to go next" | neither — inline |
| Fixed a bug inline (couldn't have been foreseen), bug fixed, task was clearly not the main one | `prune(portal)` after the fact — retroactive compression of a side episode (Question 4) |

## Rollback economics: exactly when, not just "got dirty"

The "got dirty → `prune`" reflex doesn't mean "this very second." Before rolling back, it's worth estimating:

- **≤ ~10 turns left before the subtask finishes, OR the cause is already clear and the fix will take ≤ 2 generations** → don't roll back now. Finish, close the episode, and only then — `prune(portal)` after the fact. Rolling back when the finish line is within reach wastes a warm cache for nothing.
- **Otherwise (no end in sight, > ~10 turns, or uncertainty)** → roll back now, don't wait.

The warm cache lives for a limited time (roughly the last 20 actions / 5-6 agent turns, then a few minutes of TTL until it fully cools). Past that window, the next request is read from scratch at full price regardless of whether the agent rolled back or not — waiting past that boundary saves nothing.

## `tag` — a log of the trunk, not just of cut branches

The session's table of contents (`graft` with no `target`) is, in practice, filled almost entirely with `prune` entries — pointers to what was *cut*. Nothing remains about the trunk itself — what actually stayed in the live context and got done during the session — unless it's recorded separately via `tag`. If the session ends in compaction before the next `prune`, an important decision or finding that no one was told about via `tag` is lost for good.

| Situation | Tool |
|---|---|
| Found an architectural invariant or the cause of a bug, and the knowledge itself stays needed in the trunk for the rest of the session | `tag` |
| The user gave a lesson/correction that now shapes behavior for the rest of the session (not a dead end, no branch to cut) | `tag` |
| Discovered that someone else's tool/skill is broken or outdated, and this matters for future sessions of this project | `tag` |
