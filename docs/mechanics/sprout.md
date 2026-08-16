# sprout: warm clone

```
sprout(
  task:       string,           # the clone's new main task, appended to the end of the copied context
  wait_mode:  "sync" | "async"  # optional, defaults from .mekiri/config.json
)
```

Implementation — a headless subprocess: `claude --resume <sessionId> --fork-session -p "<task>" --output-format json`. Its JSON stdout `{session_id, result}` is returned to the parent as the call's result — there's no separate "finish the clone" tool ("harvest"); the subprocess simply exits once the clone has finished typing its final answer.

The clone is started with the same `ANTHROPIC_BASE_URL`, pointing at the same mekiri-proxy daemon — rollback rules (`prune`) already applied by the parent also apply to the clone's inherited context: the clone sees the same trimmed history the parent would see on its next request.

Restarting via `--resume` preserves the prefix byte-for-byte → the cache survives the process restart.

## Limits

- **Recursion depth** is bounded not by a tool argument but by `sprout.depth_limit` in `.mekiri/config.json` — passed down to the clone via an environment variable and checked before the subprocess starts.
- **`wait_mode: "async"`** exists in the config schema but isn't implemented yet: the call is rejected with status `async_not_supported`.
- The fork is immediate: "here and now," while the cache is warm. On a transient fork error (a race with a transcript not yet flushed to disk) — retry with backoff `[50, 100, 200, 400]` ms.
- Recursion is allowed: a clone can clone and roll back on its own, but only a distillate ever comes back up.

## A clone's right to self-escalate

The context a clone inherits can turn from an asset into ballast over the course of the work — not only at the moment the tool is chosen. If a clone, from inside its forked branch, notices signs of going in circles (the same dead ends that trigger `death_reload`), that's a signal that the inherited understanding has become a source of bias right in the middle of the work. Two legitimate ways out:

- escalate and call a clean subagent within itself for a narrow question ("is the bug really where I think it is");
- return the parent not a result but a "needs a clean look" recommendation instead of a success report.

Both options are cheaper than the parent finding out only once the clone has already failed.

## When to use sprout, and when a clean subagent

Selection rule (full version with a table of contrasting examples — [gate.md](gate.md)): use a warm clone when the inherited context is an asset and you need the result rather than the process ("deal with this bug while I keep working on the feature" — needs all the current understanding of the project). Use a clean agent when the inherited context is ballast or a source of bias ("go check the docs, find this API's call format" — the parent's experience isn't needed).
