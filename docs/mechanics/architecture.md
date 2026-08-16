# Architecture: one primitive, two parameters

What looks from the outside like two different tools — `prune` and `sprout` — is conceptually one primitive with two independent settings:

```
spawn(transcript_slice, injected_message, kill_source: bool, timing: proactive | reactive)
```

- **`kill_source`** — is the source session destroyed (`prune`) or does it keep living in parallel (`sprout`).
- **`timing`** — is the operation invoked before the agent starts dirty work (proactively — it already knows it's about to get dirty), or after the mess has already piled up (reactively — after the fact).

| kill_source | timing | Scenario |
|---|---|---|
| yes | reactive | **Rollback.** The branch has already done its job, no reason to keep it alive. |
| no | proactive | **Warm clone.** The parent keeps working on the main task, the clone goes off to the side. |
| no | reactive | A rare edge case: the branch is polluted, but the parent needs to keep working on something in parallel in the old terminal for some reason while a new one starts from a clean slate. The mechanism doesn't forbid it. |
| yes | proactive | Not a separate case, just a deferred decision: "I know I'll get dirty, but I'll clean up later" — that's just a rollback triggered later, after the fact. |

From the agent's point of view, the result of both operations is structurally identical: a "new" continuation point, spawned from a distillate, with the context inherited down to the bit. The note on a rollback and the task on a fork are fields of the same object type, delivered into the tail.

## Why the implementation still differs

On Claude Code, these two values of `kill_source` are executed by two fundamentally different mechanisms — not for historical reasons, but because a rollback and a fork impose different requirements:

- **`kill_source: true` (rollback, `prune`)** doesn't need to spawn a new session — the branch being cut dies for good, so it's enough for *future* requests on this branch to no longer see it. Implemented as a rewrite at the HTTP proxy level: the source session file is never touched at all. `mekiri-proxy` is a local HTTP daemon started via `ANTHROPIC_BASE_URL`; every outgoing `/v1/messages` call goes through it. The `prune` tool registers a `{id, matchQuote}` rule in the daemon; on every next request from the same session, the daemon re-searches the current `messages[]` for the range to cut — by the quote text for the start of the range, and by the `rule_id` echoed back in `tool_result` for the end. The local session file and what the user sees in the UI never change — the rewrite exists only at the level of bytes going out to the API.
- **`kill_source: false` (warm clone, `sprout`)** has to leave the parent alive — which means the clone needs its own, honestly forked process with its own session id. Implemented as a headless subprocess: `claude --resume <sessionId> --fork-session -p "<task>" --output-format json`. The clone starts with the same `ANTHROPIC_BASE_URL`, so rollback rules already applied to the parent also apply to the clone's inherited context.

Consequence: a rollback has no "session tree" in the sense of files — there's a single session file for the parent's entire lifetime, whose history simply looks different on each successive API request.

## Addressing the boundary: a verbatim quote

The agent doesn't see internal message ids, but it does see its own text. The boundary is set by a verbatim quote — the first sentence of its own turn (8-10 words, compact and almost always unique), where the garbage starts. Retry protocol:

- Exact unique match → boundary found, cut inclusive.
- Zero matches → `not_found`, ask to copy verbatim.
- More than one → `ambiguous`, ask for a longer or different quote.
- Quote is in an already-compacted zone → `in_compacted_zone`.

No "take the last occurrence" heuristics — a silent cut in the wrong place is worse than an explicit error.

## Interaction with auto-compaction

The compacted part of the context is already a distillate; rolling back "into" it is pointless (there's nothing to clean there) and technically dangerous (quotes from consumed turns won't be found). The rollback zone is only the raw turns after the last compaction. Auto-compaction isn't disabled: it stays as an emergency valve, rollbacks just demote it from routine to a rare event.

## Target platform

Claude Code is the first implementation. The architecture is designed with an eye toward migrating to [Agent Client Protocol (ACP)](https://agentclientprotocol.com/): the current HTTP interception is a working surrogate for the moment when `session/fork` becomes a standard protocol method in ACP, not the intended solution in itself.
