---
name: mekiri-tuning
description: "Use when the user states an explicit priority about Mekiri's own behavior (token efficiency, sprout depth, parallelism, wait mode), or when reviewing .mekiri/audit.jsonl and prune/sprout metrics show a sustained signal. Governs how and when to call configure_mekiri -- never silently."
---

# mekiri-tuning

Protocol for changing `.mekiri/config.json` (`sprout.depth_limit`, `sprout.parallelism`, `sprout.wait_mode`, `priorities.token_efficiency`) via the `configure_mekiri` tool. Applies identically to the parent and to any clone.

## Trigger A — an explicit user priority

The user directly states a priority: e.g. "tokens don't matter, give me more depth/detail," "make sprout go deeper," "be aggressive about saving." Response — an immediate call:

```
configure_mekiri(patch: <change>, reason: "user_override: <brief summary of what the user said>")
```

No report, no question — the explicit statement itself is already consent.

## Trigger B — accumulated metric signal

Source — **only** `.mekiri/audit.jsonl` at the project root (JSON Lines, read it directly via Read/Bash — not via an API, no such API exists). Each line is one of: `{"event":"prune", removedBranchLength, fruitLength, ...}`, `{"event":"sprout", branchLength, harvestLength, ...}`, `{"event":"configure_mekiri", ...}`.

Only two metrics count here (the other formulas from tz.md §12.2 require analyzing session files, which you don't have when reading a single `audit.jsonl`):

- **Distillation Ratio** (per `prune` entry) = `removedBranchLength / fruitLength`.
- **Branch Compression** (per `sprout` entry) = `branchLength / harvestLength`.

Placeholder thresholds (provisional, for calibration as real data accumulates — not dogma):

| Signal | Threshold |
|---|---|
| Sustained low distillation | ≥3 consecutive `prune` entries with an average Distillation Ratio < 2x |
| Sustained low clone compression | ≥2 consecutive `sprout` entries with an average Branch Compression < 2x |
| Hit the recursion ceiling | `sprout` just returned `{"status": "depth_limit_exceeded"}` in this very turn (don't look for this in the log — such attempts aren't written there) |

**Rule:** no signal from Trigger B leads to a silent edit. The response is a short report with concrete numbers (which metric, what value, over what period) and a direct question — "what do we do." Only after the answer — `configure_mekiri(..., reason: "metric_signal: <what the numbers showed>")`.

## Caveat about contact with the user

The "ask" step from Trigger B requires live contact with the user right now:

- If there is contact (e.g. you're in an interactive REPL) — ask directly, as described above.
- If there is no contact (e.g. you're working autonomously as a sprout clone and don't talk to the user before `harvest`) — don't apply the change yourself. Carry the observation into your normal `harvest` result as part of the distillate, leaving the decision to whoever has contact with the user.

Trigger A doesn't need this caveat: if the user told the clone something directly via `task` when calling `sprout`, contact has already happened through the parent.
