# Context reset: the library replaces auto-compaction

Design and decisions: [docs/specs/2026-09-28-context-reset.md](../specs/2026-09-28-context-reset.md). Code: `packages/mekiri-proxy/src/contextReset.ts`.

## Why

Claude Code's auto-compaction summarizes the whole context in an extra model call, loses the `rule_id`s of earlier prunes, and repeats work Mekiri has already done: a Mekiri session is summarized and indexed as it goes (`capsule.md`, `report.md`, the shadow archive, the prompt log). So near the limit the proxy **resets** the context instead: it drops the middle of the conversation mechanically, keeps the tail verbatim, and has the agent warm itself up from the library.

## When it fires

On every main-thread request (side requests such as the auto-mode classifier are skipped), the daemon estimates the size of the **outgoing** request — after the existing prune cuts and resets — and resets when the estimate reaches the threshold. It checks the outgoing request rather than the previous response's `usage`, because one huge read can cross the threshold within a single turn.

- Estimate: local, deliberately on the high side (~3.2 chars per token for ASCII, ~1.6 for other text, a flat 1600 per image; base64 payloads and thinking signatures are skipped).
- Threshold (`contextReset.thresholdTokens`, `0` = auto): 90% of the point where Claude Code itself would compact (window − 13k), with a 1M window only when the request opts into it (`anthropic-beta: context-1m…`).
- Native auto-compaction stays as insurance for when Mekiri is down. Nothing needs to be pushed back: the proxy sends a smaller context, so the `usage` Claude Code sees stays small and its own compaction doesn't fire. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only move that point earlier, never later.

## Where it cuts

- Preferred: **at the last `prune`** (its call and result stay as the first kept messages), when the tail from there fits `tailTokens` (default 20k). Everything dropped is then already in the library.
- Otherwise: the last `tailTurns` turns (default 4; a turn opens at a user message that answers no tool call), shortened from the front until it fits `tailTokens`. When even one tool call doesn't fit (a giant tool result), only the last call and its result are kept.
- A tail never starts at a `tool_result`, so a `tool_use` is never separated from its result. A new reset only moves the boundary forward.
- A reset must drop at least 30% of the messages' estimated tokens, or it isn't done. Otherwise a threshold set close to prefix + tail would trigger a fresh reset on every request without freeing any real room.

## What the model sees after a reset

The prefix (system prompt, tools) is untouched. `messages[]` becomes:

1. One injected user message: the `<system-reminder>` blocks of the original first message (CLAUDE.md and the like), then the reset instruction — warm up with the "After a Mekiri context reset" section of `mekiri-warmup` first, starting from the last entries of this session's own `report.md` (named by path; its newest `kept_context` notes are the current task's state), then continue without redoing finished work — with this session's `capsule.md` inline (the `[user #N]` lines included), then **the last user prompt verbatim**, with its attachments, when it lies before the tail. When the tail starts with a user message, the injection is merged into it.
2. The kept tail, verbatim.

Claude Code still sends its full history on every request, so the reset is stored as a rule in `~/.mekiri-proxy/rules.json` (`kind: "reset"`, anchored by the hash of the first kept message plus its occurrence number, since identical messages such as Stop-hook feedback repeat; the hash ignores `cache_control` and a one-text-block message sent back as a plain string) and re-applied to every later request, after the prune cuts. A `prune` rule posted while a reset is being computed is kept: the reset is appended to the rule list as it stands when it's saved, not to an earlier snapshot. The injected text is frozen at reset time, so it stays byte-identical and cacheable.

## Nothing is lost: the `[auto-reset]` record

The stretch between the last `prune` and the start of the kept tail is in neither the library nor the new context. At reset time the proxy writes a mechanical library entry for it: a capsule line `«[auto-reset] …» — [cut] <rule_id>`, a `capsule-index.jsonl` entry (`event: "auto-reset"`) with a raw range into the shadow archive, and an activity log. `graft("<rule_id>")` opens it like any other entry; the instruction names it.

The daemon learns each session's project directory when the MCP server starts (`POST /control/session`); without one there is no config to enable the reset in the first place.

## Enabling

Off by default, like the Stop hook: the daemon is shared by every project on the machine. Per project:

```
configure_mekiri({ patch: { contextReset: { enabled: true } } })
```

Knobs: `thresholdTokens` (0 = auto), `tailTokens`, `tailTurns`. To see a reset happen in a test session, set `thresholdTokens` low.
