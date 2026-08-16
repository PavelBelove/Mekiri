---
name: mekiri-orchestrator
description: "Use before dispatching subagent-shaped work (implementation, research, review) that is supervised and produces one final result, in a project where mekiri-host is available (this repo, or another project path on this machine) -- checks for or starts a live sprout-capable mekiri-host session and prefers routing real work through its sprout tool over a generic Task subagent, per this project's dogfood-asap standing instruction."
---

# mekiri-orchestrator

Before dispatching a supervised task with a single final result through a regular Task subagent — check whether a live, sprout-capable mekiri-host session exists for the target project, and prefer it.

## How to use

1. Make sure the session is alive (starts one if not):
   ```bash
   .claude/skills/mekiri-orchestrator/scripts/ensure-running.sh <project-dir>
   ```
   Idempotent: if already running — just prints the paths; if not — brings it up and prints the paths.

2. Send the actual task:
   ```bash
   .claude/skills/mekiri-orchestrator/scripts/send.sh <project-dir> "task text"
   ```

3. Read the result from the log:
   ```
   <project-dir>/.mekiri/live-session/output.log
   ```
   (use `tail`/periodic polling, not a blocking wait — the same live session stays open for the next task).

## When NOT to use

If the task doesn't fit the "supervised task with one final report" shape (needs several independent branches of parallel work at once, or the task is substantially simpler than a single sprout call) — a regular Task subagent is still appropriate. If you decide not to use this session for real work — say so explicitly in your reply to the user, rather than silently falling back to the default.
