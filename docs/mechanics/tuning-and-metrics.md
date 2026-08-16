# Tuning and metrics

## `configure_mekiri` — when to change the config

Protocol for changing `.mekiri/config.json` (`sprout.depth_limit`, `sprout.parallelism`, `sprout.wait_mode`, `priorities.token_efficiency`) via the `configure_mekiri` tool.

### Trigger A — an explicit user priority

The user directly states a priority: for example "tokens don't matter, give me more depth/detail," "make sprout deeper," "save aggressively." Response — an immediate call:

```
configure_mekiri(patch: <change>, reason: "user_override: <brief summary of what the user said>")
```

No report and no question needed — the explicit statement itself is already consent.

### Trigger B — an accumulated metrics signal

The only source is `.mekiri/audit.jsonl` at the project root (JSON Lines). Each line is one of: `{"event":"prune", removedBranchLength, fruitLength, ...}`, `{"event":"sprout", branchLength, harvestLength, ...}`, `{"event":"configure_mekiri", ...}`.

Two metrics are computed from the raw audit records (the remaining formulas below require analyzing session files, which isn't available from reading a single `audit.jsonl`):

- **Distillation Ratio** (per `prune` record) = `removedBranchLength / fruitLength`.
- **Branch Compression** (per `sprout` record) = `branchLength / harvestLength`.

Placeholder thresholds (provisional, for calibration as real data accumulates — not dogma):

| Signal | Threshold |
|---|---|
| Consistently low distillation | ≥3 consecutive `prune` records with average Distillation Ratio < 2x |
| Consistently low clone compression | ≥2 consecutive `sprout` records with average Branch Compression < 2x |
| Hit the recursion ceiling | `sprout` just returned `{"status": "depth_limit_exceeded"}` in this very turn (such attempts aren't written to the log) |

**Rule:** no signal from Trigger B leads to a silent edit. The response is a short report with concrete numbers and a direct question, "what do we do." Only after the answer — `configure_mekiri(..., reason: "metric_signal: <what the numbers showed>")`.

If there's no live contact with the user right now (e.g. work is running autonomously as a sprout clone) — the change isn't applied on its own; the observation is carried into the clone's regular result as part of the distillate, and the decision is left to whoever has contact with the user.

## `metrics(scope?)` — the built-in metrics system

```
metrics(
  scope?: "session" | "project"  # defaults to "session"
)
```

- `scope: "session"` (default) — the tree whose `rootSessionId` matches the `sessionId` of the current call. If there isn't a single record for this session in `audit.jsonl` yet — `{ status: "not_found" }`.
- `scope: "project"` — all session trees of the project at once, for comparing between sessions or a retrospective over a longer period.

Returns `pruneCount`, `sproutCount`, `averageDistillationRatio`, `averageBranchCompression`, `totalLifetimeTokenSavings`, `totalContextProduced`, `contextRecyclingRatio`, `virtualContextLifetime`.

### Methodology

The point of the metrics system isn't lab benchmarks or comparing models against each other, but indicators computed automatically from the history of a specific agent's work. All the necessary data is already contained in the session tree: for every `prune`, the length of the removed branch, the length of the recorded distillate, its position relative to the history, the number of subsequent requests, and whether/when compaction happened are all known; for every `sprout` — the length of the independent branch, the size of the returned report, its position relative to the main branch. All statistics are computed after the fact, with no extra logging.

### Formulas

**Distillation Ratio** — how effectively temporary working context was turned into knowledge.

```
Distillation Ratio = length of removed branch / length of fruit
```

Example: 12,400 tokens removed, fruit is 510 tokens → 24.3x.

**Branch Compression** — the analogous metric for a warm sprout.

```
Branch Compression = length of clone branch / length of harvest
```

**Lifetime Token Savings** — the main economic metric. If R tokens were removed, and N requests happened after that, the retransmission avoided amounts to `R × N`. Summing over all `prune` calls gives the total savings for the session — an exact figure computed from the tree's history, not a projection.

**Virtual Context Lifetime** — how much `prune` and `sprout` extended the working context's life. A virtual linear session is constructed (all prune branches are folded back into the main stream, all sprouts are treated as if executed by the main agent), and then the point at which such a virtual context would have hit the compaction limit is computed. Example: actual compaction at turn 61, virtual at turn 34 → 79% extension of the context's life.

**Context Recycling Ratio** — what fraction of all context produced during the session turned out to be temporary working material that was successfully recycled into compact knowledge.

```
Context Recycling Ratio = Σ removed prune branches / Σ total context produced
```

## `nudge-hook` — a forced reminder

Not an MCP tool, but a PostToolUse hook (`bin/nudge-hook.ts`) wired directly into Claude Code settings; it receives JSON on stdin with `session_id`/`tool_name`/`cwd` after every tool call. It exists because a soft, consequence-free hint doesn't work in practice: the agent reads it as advisory, decides each time that "the episode isn't closed yet," and can go a whole session without calling a Mekiri tool even after the hint has already fired.

State (`NudgeState`) is kept per session in `.mekiri/hook-state/<session_id>.json`: `{ callsSinceReset, threshold, consecutiveIgnored, deferRemaining }`.

- `threshold` — a random integer from `[2, 10]`, a statistical stand-in for "a logical block of work just closed" (the hook sees one tool call at a time, with no cross-call semantics).
- Any Mekiri tool call resets `callsSinceReset` and `consecutiveIgnored` to 0 and rerolls `threshold`.
- When `callsSinceReset` reaches `threshold`, the hook issues a soft reminder that escalates in tone on the 2nd and 3rd+ consecutive trigger without a reset.
- After `HARD_BLOCK_AFTER = 3` consecutive ignored reminders, the hook returns `{ decision: "block", reason }` instead of advice — but not for every subsequent call.

### The hard block blocks mutation, not verification

A blind call counter can't tell "the agent forgot about Mekiri" apart from "the agent is right in the middle of checking what it just did" (wrote a file, next step is to run the test). Blocking both Read and the test run at that moment would force the agent to write a `fruit` before it's had a chance to verify what it's claiming — i.e., it would mechanically provoke fabrication (see [[feedback_mekiri_fruit_accuracy]]).

So `isMutatingCall(toolName, toolInput)` in `nudgeHook.ts` splits calls into two classes:
- **Non-mutating** (`Read`/`Grep`/`Glob`, and `Bash` with a command that doesn't match the mutating-pattern blocklist like `rm`, `git commit|push|reset`, `npm install`, `> file`, `sed -i`, `mkdir`, `curl`, etc.) — pass through even under a hard block, state stays frozen.
- **Mutating** (`Write`/`Edit`/`NotebookEdit`, `Bash` with a command from the blocklist, or `Bash` with no readable `command` — conservatively by default) — blocked as before.

This isn't a safety boundary (the list is a permissive blocklist, not a strict allowlist), but a habit nudge: the goal isn't to prevent a rare dangerous command from slipping through, but to keep the agent from falling into the trap of "lie in the fruit to get unblocked."

### Structural deferral (`nudge.deferCalls`)

A text excuse like "nothing closed, continuing" never reset the counter (only an actual Mekiri tool call does) — escalation toward the hard block kept going regardless. In its place — an explicit, auditable grant via `configure_mekiri({ patch: { nudge: { deferCalls: N } }, reason })`: the next `N` calls after that are fully exempted from the counter and the hard block (they neither increment nor block, even if a block was already active), after which `nudge.deferCalls` in `.mekiri/config.json` automatically resets to zero — the grant is always one-time, never a permanent setting.
