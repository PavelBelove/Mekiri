В чате всегда отвечай на русском.

# Mekiri — agent instructions

This is the Mekiri project itself (context-hygiene tool for AI agents; see whitepaper.md and tz.md for the full design).

Before dispatching subagent-shaped work (implementation, research, review) that is supervised and produces one final result, check the `mekiri-orchestrator` skill -- it starts or reuses a live `mekiri-host` session and prefers routing real work through its `sprout` tool over a generic Task subagent, per this project's standing dogfooding policy. Fall back to a generic subagent only when that's genuinely impractical for the task's shape, and say so explicitly rather than defaulting silently.

Whenever a closed micro-episode ends in this session (finished reading a file for one question, one test run, one diff reviewed for one verdict) and Mekiri's own `prune`/`sprout` MCP tools are available, check the `mekiri-gate` skill before moving on -- don't wait for the whole task to end or batch several closed episodes together.
