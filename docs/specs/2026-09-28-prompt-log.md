# Prompt log — design spec (stage 1 of the context-reset work)

Status: approved by the owner on 2026-09-28. Stage 2 (mechanical context reset replacing Claude Code's auto-compaction) builds on this: [2026-09-28-context-reset.md](2026-09-28-context-reset.md).

## Why

Mekiri's library records what the *agent* concluded (`prune` distillates), but not what the *user* asked. Two problems follow:

- After any context loss (auto-compaction today, Mekiri's own reset in stage 2) the agent can forget the instruction it was executing — "fix these 7 bugs", interrupted at bug 2, reported as "done".
- Warming up from the library shows the agent's side of a past session only; the user's corrections, sprint agreements and pasted evidence are invisible.

Stage 1 makes every user prompt durable, indexed, and retrievable through `graft`, without putting its text anywhere near a git repository.

## Where the data lives

`~/.mekiri-proxy/prompts/<sessionId>/` — next to the existing shadow archive (`~/.mekiri-proxy/raw-transcripts/`), **outside the project**. Users paste API keys, tokens and personal data into prompts; `.mekiri/` is gitignored, but a single mistake in a user's project would publish everything. The project's library only ever gets metadata (see "Capsule lines").

```
prompts/<sessionId>/
  index.jsonl      one PromptMeta per line, append-only
  001.md           verbatim prompt text (blocks joined with blank lines)
  001-1.png        attachments, decoded from base64 image/document blocks
  002.md
  ...
```

Directory mode `0700`, files `0600`.

```ts
interface PromptMeta {
  n: number;                 // 1-based, per session
  timestamp: string;         // when the proxy first saw it
  messageIndex: number;      // index in the wire messages[] it came from
  textHash: string;          // sha256 of the prompt text, for dedup
  bytes: number;
  lines: number;
  kind: "speech" | "log" | "code" | "mixed";
  gzipRatio: number;
  interrupted: boolean;      // came right after "[Request interrupted by user]"
  ideOpenedFile?: string;    // path only -- the block itself is not kept
  attachments: { file: string; mediaType: string; bytes: number }[];
}
```

## Recognizing a user prompt on the wire

Verified against this project's own live traffic (session `a1ed4f55…`, 2026-09-28), not assumed. The user takes the microphone in three situations: the first message of a session, after the agent's turn ends (Stop hook hands control back, or the user forks the session), and after an interruption (user pressed stop, network drop, limits hit).

What the wire actually looks like:

| Situation | `role: "user"` message content |
|---|---|
| First message | `<system-reminder>…` text blocks (CLAUDE.md, context, attribution), `<ide_opened_file>…`, optionally `<ide_selection>…`, then the prompt text |
| Normal turn end | `<ide_opened_file>`/`<ide_selection>` blocks (optional), prompt text |
| Stop-hook continuation | single text block starting `Stop hook feedback:` — **not** a prompt |
| Skill load | `tool_result` + text starting `Base directory for this skill:` — **not** a prompt |
| Interrupt | `tool_result` (if a tool was running), text `[Request interrupted by user]`, then the new prompt — **merged into the same message** |
| Hook context | separate message with `role: "system"`, text `PostToolUse:… hook additional context` — **not** a prompt |

Rule — a denylist over blocks, not an allowlist over messages. Unknown machine text slipping into the log is cheap; a real user instruction slipping out of it is exactly the failure this feature exists to prevent.

For each `role: "user"` message, drop:

- `tool_result` blocks;
- text blocks starting with `<system-reminder>`;
- text blocks starting with `<ide_opened_file>` (the path goes to `PromptMeta.ideOpenedFile` — it is the IDE's active tab, sent automatically, usually noise);
- text starting with `Stop hook feedback:`;
- text starting with `Base directory for this skill:`;
- the marker text `[Request interrupted by user]` (and its `… for tool use]` variant) — it sets `interrupted: true` instead;
- text starting with `This session is being continued from a previous conversation` (Claude Code's compaction summary, sent as a user message; found during implementation);
- whole messages whose first text starts with `The following is the user's CLAUDE.md configuration` or `<transcript>` (auto-mode classifier side requests; only reachable through backfill of archives written before the side-request gate below).

Identical blocks inside one message are logged once: a retry after a network drop was seen resending the prompt twice around the interrupt marker.

Whatever text, image or document blocks are left form the prompt. `<ide_selection>` blocks are kept: that is text the user deliberately selected, and it has been observed carrying the entire prompt.

`interrupted` is recorded rather than interpreted. On the wire, a user pressing stop to correct the agent and a dropped connection followed by "continue" look identical. The flag is shown in the capsule so the agent reading it knows a correction may be inside.

## Dedup, and a shadow-archive bug found along the way

Claude Code resends the whole history on every request, so both the shadow archive and the prompt log must process only what's new. The shadow archive does that by comparing `messages.length` against the last seen length. **That misses interrupts**: stopping the agent mid-generation doesn't add a message — Claude Code appends the marker and the new prompt *into the last existing user message*, so the next request has the same length with a changed last message. Verified: in this project's shadow archive, line `…-69` holds only the `tool_result`; the user's post-interrupt prompt ("Ок, я остановил спринт…") was never archived.

Fix, shared by both writers: per session, keep `lastSeenLength` **and** `lastMessageHash` (sha256 of the last message's JSON).

- Length grew → process the new tail as today; also re-check the previously last message if its hash changed.
- Same length, hash changed → the last message was edited in place: re-process it.
- Length shrank → auto-compaction; existing behaviour.

Shadow archive: an edited last message is appended as a new line with its own unique `uuid` (prune resolves boundaries by uuid, so uuids must stay unique), `revision: true` and `revisionOf: <original uuid>`, instead of rewriting the file. Append-only is preserved, so recorded `rawStartLine`/`rawEndLine` ranges stay valid, and `graft` shows both versions in order. Lazy reseed from disk must count only non-revision lines towards `lastSeenLength`, and take `lastMessageHash` from the last line.

Prompt log: a re-processed message yields only the prompt blocks not already logged for that `messageIndex`. After a compaction shrink, a candidate whose `textHash` matches one of the session's last 20 logged prompts is skipped. Compaction keeps a verbatim tail that was already logged.

**Side requests (found during implementation).** Not every request carrying a session's id is its main conversation. The auto-mode permission classifier sends short requests under the same id (a CLAUDE.md message plus a `<transcript>` of the conversation). The length-only dedup took each of them for a compaction shrink and archived it. The next main-thread request was then longer than 2 messages, so almost the whole history was archived again after it: in this project's shadow archive, lines 138–162 duplicated 113–135. Fix: the shadow archive tracks the hash of the main thread's `messages[0]`, which is stable across requests because prompt caching depends on it. A different first message starts a new thread only if it is a compaction summary, or if the array is longer than the tracked one (the tracked "thread" was itself a side request, e.g. right after a restart). Anything else is a side request: it is not archived, and `appendNewShadowMessages` returns `false` so the daemon skips the prompt log too. Reseed starts the thread at the last compaction summary on disk.

Backfill: the first time the proxy sees a session with a shadow archive but no `prompts/` directory, it runs recognition over the shadow archive once. Prompts the shadow archive itself lost (the interrupt case above, before the fix) can't be recovered this way. That gap is accepted, not papered over.

## Classifier

Cheap, no model, computed once at write time:

- **gzip ratio** (`zlib.gzipSync`) — logs and console dumps repeat and compress 10–20×, human speech 2–3×. Only computed for texts ≥ 512 bytes; shorter ones are too small to compress meaningfully.
- **log-line share** — lines matching timestamps, `[INFO]`/`ERROR`/`WARN`, stack frames (`at …(`, `File "…", line`), long paths.
- **code-line share** — lines ending in `;`, `{`, `}`, `)`; lines starting with keywords (`function`, `const`, `def`, `import`, `class`); fenced blocks.
- **letter share** — letters and spaces vs digits and punctuation.

`kind` = `log` / `code` if that share dominates, `speech` if letter share is high and gzip ratio low, `mixed` otherwise. The initial thresholds are placeholders, fixed in tests against real samples from this repo's own shadow archive, and tuned later.

## Capsule lines

The proxy doesn't know the project directory; the MCP server does. On every `prune` (which the Stop hook forces at each turn end), before writing the prune's own entry and under the same `withDirMutex`, the MCP server reads `index.jsonl` for its session. For every prompt not yet recorded in the project's `capsule-index.jsonl` (new entry kind `event: "prompt"`, carrying `n`), it writes a capsule line:

```
[user #7] 12:22 · 96 KB · 1 812 lines · log · interrupted · 2 attachments — graft("user#7")
[user #8] 12:25 · 64 B · speech — graft("user#8")
```

Metadata only, never prompt text. The chronology in `capsule.md` becomes prompt → prunes → prompt → …, at most one turn late.

## `graft` for prompts

New target grammar, next to the existing `rule_id`:

- `user#7` — one prompt of the current session;
- `user#7-10` — an inclusive range;
- `<sessionId>:user#7` / `<sessionId>:user#7-10` — a past session, for warmup.

The response is one header per prompt (`[user #7 · 12:22 · 96 KB · log · interrupted]`) followed by the verbatim text. Image attachments are returned as MCP image content blocks, so the agent sees them without a `Read` call outside the project (which would cost a permission prompt on a foreign machine); documents come back as absolute paths. The existing `RAW_CONTENT_CHAR_LIMIT` applies to the whole response. When a range is cut, the result says exactly which prompts were cut and suggests a narrower range.

## Nudge-hook adjustment

An empty `prune` (`quote: ""`) made in response to the Stop hook no longer counts towards the "N idle prunes in a row" warning. The owner's call: such prunes are continuity markers that keep the report sequential, not avoidance. Empty prunes in the middle of a turn still count. Mechanism: when the Stop hook blocks, it sets `nudge.stopForcedPrune` in the hook state; the next Mekiri call clears it, and a trace-only prune made while it is set neither increments nor resets the idle counter.

## Tests

- Recognition, on fixtures cut from this repo's real traffic: first message with system-reminders/ide blocks, Stop-hook feedback, skill load, interrupt merged into a `tool_result` message, `role: "system"` hook context, `<ide_selection>`-only prompt.
- Dedup: same-length edited last message (shadow gets a `revision` line, prompt log gets the new prompt only once); compaction shrink; daemon-restart reseed with revision lines present.
- Classifier on real samples: a Russian prose prompt, a pasted log, a code paste.
- Attachments: base64 image and PDF decoded to files with the right extensions and sizes.
- Capsule lines written once, in order, before the prune entry; no text leaks into `.mekiri/`.
- `graft` for single, range, cross-session, oversize range, missing prompt, image attachment.

## Docs

- `docs/mechanics/library.md` and `prune-and-graft.md`: the prompt log, capsule `[user #N]` lines, `graft("user#N-M")`, and why it lives outside the project.
- `INSTALL.md` / `AGENT-SELF-SETUP-GUIDE.md`: nothing new to configure; one line in the security note saying prompts are stored under `~/.mekiri-proxy/`, not in the project.

## Live verification

After the owner restarts the IDE (the daemon is not killed by the agent — a previous kill caused a real API outage):

1. `graft("user#1-5")` in this session returns the backfilled prompts, including the one sent inside `<ide_selection>`.
2. A fresh prompt appears as a `[user #N]` line in `capsule.md` after the next turn.
3. An interrupt with a correction produces an `interrupted` prompt in the log and a `revision` line in the shadow archive.
