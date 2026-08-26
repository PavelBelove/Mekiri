---
name: mekiri-warmup
description: "Use at the start of a session when context is thin -- a fresh session that holds essentially just the user's first message, or a sprout/subagent clone that just received a task its inherited context doesn't cover -- or any time mid-session inline knowledge is insufficient and a past session on this project plausibly already worked it out. Governs how to search Mekiri's own session library (sessions-index.md, capsule.md, report.md), when to graft a raw fragment, and how to prune the search itself into a reading-list note instead of leaving it as ballast."
---

# mekiri-warmup

Warming up: turning Mekiri's own archive of past sessions into a running start for this one, instead of starting cold or reading through the archive wastefully. The library ([prune-and-graft.md](../../../docs/mechanics/prune-and-graft.md#the-archive-as-the-project-library), [library.md](../../../docs/mechanics/library.md)) exists precisely for this; this skill is the habit that actually uses it.

## When this applies

- A session just started and context holds essentially one thing: the user's first message.
- A sprout clone or a clean subagent just received its task, and the inherited (or absent) context doesn't cover what it needs to know about this project's past decisions.
- Mid-session, a question comes up that inline knowledge doesn't answer, and it's plausible a previous session already worked it out — a decision, an invariant, a past bug's root cause.
- The user directly asks about the project's own past — what was decided, why, when, or what a previous session (or a different agent) actually did. This is the library's core use case: reach for it instead of answering from inline memory or re-deriving an answer from the current code, since the code shows what things are now, not the reasoning behind why they got that way.

Not for: routine work where you already know enough to proceed. Warming up has its own cost (reading files) — don't do it out of habit when the task doesn't need project history.

## The three-hop path

1. **`.mekiri/sessions-index.md`** — one line per session, human-readable, appended in order, so its last line is always the most recently closed session on this project. Skim it to work out *which* sessions are relevant (by date, by summary text) — but treat the last line as a default candidate regardless of whether its summary sounds topically related: whatever the immediately preceding agent was doing is, with high likelihood, connected to why a new session just started on this project at all. Don't open every other session's capsule blind.
2. **`capsule.md`** of each relevant session (via its `.mekiri/sessions/<date-slug>/` alias) — the table of contents of that session's `prune` calls, tagged `[kept]`/`[cut]`/`[kept+cut]`. Skim entries by summary to find candidates.
3. **`report.md`** in the same folder — the actual distillate bodies. Read only the ranges that looked promising from `capsule.md`, not the whole file front to back — across a project's history it can be long, and most of it won't be about your current question.

## Correlating with git history

Commit timestamps are known, and every `sessions-index.md` entry carries a real time range too — when a question is about *why* a specific commit happened, a commit's date is usually enough to find the session(s) whose time range brackets it, without guessing from the commit message alone. Faster than searching by topic when the commit message is terse or misleading about the actual reasoning.

## Write yourself a reading list, then prune it

Skimming the index plus several `capsule.md` files is itself exploration — dozens of one-line entries, most irrelevant to what you actually needed. Once you've identified which `report.md` ranges are worth reading (or decided none are), that skimming episode is closed and its raw output is ballast:

```
prune(quote: "<end of the skimming episode>", note_type: "portal",
      fruit: { summary: "warmup: scanned N sessions for <question>",
               kept_context: "<the reading list itself: concrete rule_id/report.md pointers, or 'checked, nothing relevant'>" })
```

This is not optional cleanup — it is the "reading list" this skill exists to make you leave behind. `kept_context` is the thing a later turn (or a later session, via `graft`) actually acts on. A stated negative ("checked, no relevant precedent") is as valuable as a positive hit — it stops a future prune from re-treading the same search.

## `graft` — only when the distillate itself needs checking

Reading `report.md` ranges normally is enough on its own — it is already a distillate a past agent wrote at the moment of full understanding. Reach for `graft(rule_id)` only when that distillate is insufficient in a stated way: it references a decision whose exact wording matters, it reads as abbreviated in a way that leaves an operational question open, or you suspect it was written before the underlying work was actually verified ([[feedback_mekiri_fruit_accuracy]]) and needs checking against what really happened.

`graft` returns a raw transcript fragment, not a second distillate — it can run long (up to a hard truncation limit) and is exactly as much ballast as any other raw exploration once you've pulled what you needed from it. The moment you have your answer:

```
prune(quote: "", note_type: "portal",
      fruit: { summary: "...", kept_context: "<the specific fact recovered via graft>" })
```

Archive what `graft` actually told you — don't leave the raw fragment sitting in context "for later," waiting for some unrelated prune to sweep it up. This mirrors `mekiri-gate`'s own "got dirty → prune" reflex, applied specifically to the moment right after a `graft` call resolves.

## Contrasting examples

| Situation | Action |
|---|---|
| Fresh session, first message is "continue the ACP work" with no other context | warm up — skim `sessions-index.md` for ACP-related sessions before doing anything else |
| Fresh session, first message is fully self-contained ("fix this one-line typo in README") | skip warmup — nothing to gain |
| Mid-session, hit "why does X work this way" and no one in this conversation has explained it | plausible warmup candidate — check the library before guessing or re-deriving from code alone |
| Skimmed 6 sessions' capsules, found 2 relevant `report.md` ranges | `prune(quote: "...", kept_context: "<the 2 ranges>")` immediately — don't carry the other 4 sessions' irrelevant entries forward |
| `graft`ed a `rule_id` to verify a distillate's exact wording, got the answer | `prune` right after, archiving only the recovered fact, not the raw fragment |
| `report.md` already answers the question directly | no `graft` needed — trust the distillate (per `mekiri-gate`'s "symmetric error" section) |
