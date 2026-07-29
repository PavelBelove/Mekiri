# Finding: transcript `messageId` → `messages[]` array position is NOT 1:1

Spike for Task 2 of the `mekiri-proxy` implementation plan. Blocks Task 4
(`rewriteMessages`) from assuming a raw index correspondence between a
transcript-resolved `messageId` (the output of `quoteMatcher.findBoundary`)
and a position in the real outbound `messages[]` request array.

## Method

Reused the throwaway-proxy pattern already validated and consented to in
`wire-prune-findings.md` §3. Threw away `packages/mekiri-proxy/scratch/inspect-boundary.mjs`
(a dumb transparent HTTP→HTTPS forwarder to `api.anthropic.com` on
`127.0.0.1:8792` that writes every outbound `/v1/messages` body to
`scratch/dumps/req_N.json`) plus its captured dumps per Step 5 — nothing
from that script survives; this document is the only durable artifact.

Ran a real 3-turn conversation through it via `ANTHROPIC_BASE_URL`:

```
SESSION=$(claude -p "Reply with exactly: TURN1" --output-format json | ...)
claude --resume "$SESSION" -p "Run: echo hello (use your Bash tool)" --output-format json
claude --resume "$SESSION" -p "Reply with exactly: TURN3" --output-format json
```

This produced **5** captured requests, not 3 — `req_1.json` turned out to be
an unrelated side-channel call (session-title generation, matching the
transcript's own `type: "ai-title"` line — its `messages[0]` is a synthetic
`<session>...</session>` + title-instruction prompt, a completely different
conversation from the real one). `req_2`..`req_5` are the real conversation:
one outbound request per model round-trip (turn 2's tool call caused two
round-trips — one that emits the `tool_use`, one that supplies the
`tool_result` and continues). `req_5.json` (8 messages) is the most complete
snapshot and is what's compared below.

Real transcript resolved at
`~/.claude/projects/-home-pol-dev-rollback-packages-mekiri-proxy/96f4216c-1fbe-48f4-9356-8084cf1cc30c.jsonl`
(cwd for the `claude` invocations was `packages/mekiri-proxy`, so the
sanitized project-dir segment includes that suffix — `sanitizeDir` from
`sessionTranscript.ts` applied to the actual cwd, not the repo root, is
what must be used).

## Outcome: **Not 1:1**

Filtering the transcript to `type === "user" || type === "assistant"` and
`!isSidechain` (`quoteMatcher.ts`'s own filter, extended from
assistant-only to both roles since a cut point can land on either) gives
**9** entries. `req_5.json`'s `messages[]` has **8** entries. Side-by-side:

| # | Transcript (filtered) | uuid | | # | `messages[]` (`req_5.json`) |
|---|---|---|---|---|---|
| t0 | user "Reply with exactly: TURN1" | `9f7acc98` | → | m0 | user (2 text blocks: injected `<system-reminder>` CLAUDE.md/MEMORY.md dump + the query) |
| t1 | assistant `['text']` "TURN1" | `a95e388c` | → | m2 | assistant `['text']` "TURN1" |
| — | *(no transcript line)* | — | → | **m1** | **`role: "system"`** `['text']` "\<system-reminder\>Available agent types...\</system-reminder\>" |
| t2 | user "Run: echo hello..." | `3c4faf2a` | → | m3 | user (string) "Run: echo hello..." |
| t3 | assistant `['thinking']` | `c8b8e9d7` | → | m4 | assistant `['thinking','tool_use']` (**merged**) |
| t4 | assistant `['tool_use']` | `18a158fe` (parentUuid = t3's uuid) | → | m4 | *(same entry as t3)* |
| t5 | user `['tool_result']` | `eafdc3be` | → | m5 | user `['tool_result']` |
| t6 | assistant `['text']` "hello" | `e8d01839` | → | m6 | assistant `['text']` "hello" |
| t7 | user "Reply with exactly: TURN3" | `576c9982` | → | m7 | user (string) "Reply with exactly: TURN3" |
| t8 | assistant `['text']` "TURN3" | `2398edd7` | → | *(not yet sent — would appear as m0 of the next request)* | |

Two independent, systematic discrepancies, found together in this single
short conversation:

### 1. A `role: "system"` entry is injected mid-array with no transcript counterpart

`req_5.json`'s `messages[1]` has `role: "system"` — a role that never
appears in the transcript's `type` field at all (transcript only ever has
`"user"`/`"assistant"` for real turns). Its content ("Available agent
types for the Agent tool: ...") is **not** the same system-reminder that
got folded into `messages[0]`'s extra text block (CLAUDE.md/MEMORY.md) —
that one *is* embedded as a second `text` content block inside the
existing user message (`m0`), not a separate array entry, and so does not
break index counting on its own.

The `role: "system"` entry's content matches the transcript's `type:
"attachment"` lines (`agent_listing_delta`, `skill_listing` — lines 3–4 of
the raw `.jsonl`, `uuid: 3678f101...`/`547b982f...`), which are excluded by
`quoteMatcher.ts`'s filter (it only ever looks at `type !== "assistant"` →
skip, i.e. matches text on assistant lines; attachments are never
`"assistant"`). So this is a real, reproducible index-space mismatch: one
array slot in `messages[]` that the transcript's user/assistant-filtered
view has no entry for, positioned *before* the first assistant reply. This
matches the `mid-conversation-system-2026-04-07` beta flag already noted in
`wire-prune-findings.md` §4 — confirmed here at the request-body level, not
just inferred from the beta-flags list.

Practical effect: it appeared exactly once, immediately after the first
user turn, and stayed at that fixed position as the array grew (confirmed
present at the same offset in `req_3.json`, `req_4.json`, and `req_5.json`)
— i.e. not repeated once per turn in this run, but there is no guarantee
from a 3-turn sample that it can never recur later in a longer session.

### 2. A single logical assistant turn can span two transcript lines but only one `messages[]` entry

The transcript records `thinking` (`c8b8e9d7`) and `tool_use`
(`18a158fe`, `parentUuid` = the thinking line's uuid) as **two** separate
JSONL lines/uuids — a parent→child chain within one conversational step.
The actual API request combines them into **one** `messages[]` array
entry (`m4`, `content: [thinking, tool_use]`). So N transcript lines
belonging to the same round-trip collapse to 1 array position — the
opposite direction of discrepancy #1, and it doesn't cancel out
positionally except by coincidence (they happen to net to the same total
count here; they do **not** correspond to the same array index once
counted from the front, as the table shows).

### Net result

A naive `keepFromIndex = (filtered transcript index of matched uuid) + 1`
is wrong from the very first assistant match onward: `t1` (transcript
index 1) would incorrectly compute `messages[]` index 1 (the `role:
"system"` entry) as the cut point, when the real answer is index 2 (`m2`
is `t1`'s own reply) and the correct *keep-from* boundary is index 3 (`+1`
past `m2`).

## Correction rule Task 4 must implement

Do not use index arithmetic on the transcript position at all. Instead,
resolve the cut point by content match directly against the real
`messages[]` array:

1. `quoteMatcher.findBoundary` already only ever matches a quote against
   `type: "assistant"` transcript lines' **`text`**-type content blocks
   (see `messageContainsQuote` in `quoteMatcher.ts`) — never `thinking`,
   never `tool_use`. This means the matched transcript line's text always
   corresponds to a `messages[]` entry that is *itself* text-bearing on
   that role — a final reply, never a thinking/tool_use-only turn (a
   thinking+tool_use turn has no `text` block for the quote to land on in
   the first place, so it structurally can't be the match target).
2. Given the matched quote string, walk `messages[]` from the start,
   filtering to `role === "assistant"`, and find the entry containing a
   content block with `type === "text"` whose text contains the quote
   (mirrors `messageContainsQuote`'s own check, just against the request
   array instead of the transcript array).
3. `keepFromIndex = matchedArrayIndex + 1`, computed **in `messages[]`
   index space directly** — never translated from a transcript-side count.
4. This is naturally robust to both discrepancies found here: `role:
   "system"` entries are skipped by the `role === "assistant"` filter
   (discrepancy #1 never enters the count), and thinking/tool_use-merged
   entries are never candidates for the match in the first place
   (discrepancy #2 is moot since the match always targets a distinct,
   unmerged text-bearing entry).
5. Ambiguity handling (multiple matches) should mirror `quoteMatcher.ts`'s
   existing `ambiguous`/`not_found` statuses, just re-run against
   `messages[]` instead of assumed via index math.

## Caveats / things a future spike should still check

- Only one short (3-turn, single-tool-call) conversation was sampled; the
  `role: "system"` injection was observed once, at a fixed early position.
  Whether it (or similar mid-conversation system injections) can recur
  later in a long session, or whether other beta features inject further
  non-user/assistant array entries, was not exhaustively tested.
- Multi-tool-call turns (several `tool_use`/`tool_result` pairs in one
  round-trip) and parallel tool calls were not exercised here — the
  thinking+tool_use merge behavior was only confirmed for a single tool
  call.
- The `ai-title` side-channel request (`req_1.json`) is a reminder that
  not every request hitting `/v1/messages` in a live proxy belongs to the
  session under prune — Task 4 (or whatever component identifies "the"
  live request to rewrite) needs to key off the actual session/model
  correlation, not just "most recent request seen," to avoid ever mutating
  an unrelated side-channel call.
