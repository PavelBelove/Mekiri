---
name: mekiri-gate
description: "Use before choosing how to dispatch work inside a mekiri-host session -- prune vs sprout vs a clean Task subagent vs staying inline. Applies identically to the parent session and to any sprout clone."
---

# mekiri-gate

The gate for choosing a dispatch tool inside mekiri-host: `prune` / `sprout` / a clean subagent (Task) / inline work. Applies identically to the parent session and to any sprout clone.

**Quick reflex**: got dirty — `prune`. About to get dirty on a subtask — `sprout`. Below is the full gate for cases where that's not obvious (in particular, Question 1 can rule out a fork entirely).

## What `prune` actually does to the context

`prune` is not a UI collapse and not a "mark as unimportant" — it's a real cut: the range from the quote to the current moment is physically removed from the session's live context and replaced with a distillate. That's by design, not a side effect — it's the whole point of the tool. If, after a rollback, a past reply (yours or the user's) that you expected to find is missing from the context, that's almost always `prune` working as intended, not a model glitch or someone else's hallucination.

Verify this through `graft`, not by rewriting from scratch. Before telling the user "that didn't happen" or "I mixed something up" about your own past turn — first `graft(rule_id)` (see [tz.md §6.5](../../../tz.md#65-grafttarget)), check against the original, and only then draw a conclusion. The distillate exists exactly for this kind of recovery: everything of value from the cut range is in there.

**The symmetric error — distrusting your own successful `prune`.** `prune` returned `ok` with an honest `fruit` that you yourself wrote about work that was genuinely done (not invented) — and a few turns later the urge arises to rerun the same commands "just in case," because the tool calls from the cut range are no longer visible in the context. This is not a glitch and not a reason to double-check — this is exactly what a successful `prune` is supposed to look like: the cut erased the history but didn't undo the fact. The distillate in `fruit` can be trusted as an accomplished fact without re-execution; if the result is in doubt, use `graft(rule_id)`, not a rerun of work that's already deleted/tested/committed. A related symptom of the same error is blaming the disappearance of your own recent tool calls on auto-compaction when the cause is right in front of you: your own `prune` earlier in this same turn.

## `tag` — a log of the trunk, not just of cut branches

The session capsule (`graft` with no `target`) is currently, in practice, filled almost entirely with `prune` entries — that is, pointers to what was *cut*. Nothing remains in the capsule about the trunk itself — what actually stayed in the live context and got done during the session — unless it's recorded separately. If the session ends in compaction before the next `prune`, an important decision or finding that you never told anyone about via `tag` is lost for good — not as a distillate, but entirely.

Reflex: as soon as a fact, invariant, or decision appears in the trunk (without a cut) that a) isn't a reason for a rollback right now, and b) would be worth being able to pull via `graft` from a future session or after this one compacts — call `tag` right after stating it in text, without waiting for the next `prune`. Don't wait for several such findings to pile up.

| Situation | Tool |
|---|---|
| Found an architectural invariant or the cause of a bug, and the knowledge itself stays needed in the trunk for the rest of the session | `tag` |
| The user gave a lesson/correction that now shapes your behavior for the rest of the session (not a dead end, no branch to cut) | `tag` |
| Discovered that someone else's tool/skill is broken or outdated, and this matters for future sessions of this project | `tag` |

## Rollback economics (exactly when, not just "got dirty")

The "got dirty → prune" reflex doesn't mean "this very second." Before rolling back, quickly estimate:

- **≤ ~10 turns left before the subtask finishes, OR the cause is already clear and the fix will take ≤ 2 generations** → don't roll back now. Finish, close the episode, and only then — `prune(portal)` after the fact (see Question 4 below). Rolling back when the finish line is within reach wastes a warm cache for nothing — finishing the soup is cheaper than washing the bowl early.
- **Otherwise (no end in sight, > ~10 turns, or uncertainty)** → roll back now, don't wait.

Don't drag it out past what's needed: the warm cache lives for a limited time (~20 most recent actions, 5-6 agent turns, then a ~5-minute TTL until it fully cools). Past that window, the next request is read from scratch at full price — whether you rolled back or not no longer matters. Waiting past that boundary saves nothing, it just piles up garbage with no compensation.

## Three questions in order (before you start)

**Question 1: is the task dispatchable at all?**
If the work will need user intervention, course correction, or can't be stated in a single pass — neither a clone nor a clean subagent will work, regardless of asset/ballast. The point of a fork is isolation plus a single report at the end; that's incompatible with needing to keep a hand on the wheel. Work like that stays inline, in the main thread.

**Question 2 (if yes): is the inherited context right now an asset or ballast?**
- Asset, you need the result rather than the process → a warm clone (`sprout`).
- Ballast or a source of bias → a clean subagent (Task tool), without inheriting the current context.

**Question 3 (for a clone, while it's working): does the context remain an asset?**
If signs of getting stuck show up inside the instance (the same dead ends that trigger `death_reload`) — the clone has the right to self-escalate:
- call a clean subagent within itself for a narrow question;
- return the parent not a result but a recommendation via `harvest(result, needs_clean_look: true)` instead of reporting success.

Both options are cheaper than the parent finding out only once the clone has already failed.

**Question 4 (for inline work, once it's done): is the side episode closed?**
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
