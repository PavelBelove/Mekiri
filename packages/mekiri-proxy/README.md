# mekiri-proxy

Gives any Claude Code session (a regular one, not a separate REPL) a real `prune`/`sprout`/`configure_mekiri` — by rewriting `messages[]` at the level of the HTTP request to the Anthropic API, before it goes out. The local conversation view in the UI is never touched; only what actually goes over the wire is cut. The warmed cache survives the cut: only the tail after the rollback point is trimmed, the prefix stays byte-for-byte the same.

**Status (alpha)**: `prune`/`sprout`/`tag`/`graft`/`configure_mekiri`/`metrics` are implemented and working.

How this is built at the architecture level — [`../../docs/mechanics/architecture.md`](../../docs/mechanics/architecture.md).

## Installation

Full turnkey instructions (including setup inside a third-party project) — [`INSTALL.md`](INSTALL.md).

## What to check yourself next

- `prune` will show a tool error if the daemon didn't come up — check `curl http://127.0.0.1:8791/health`, it should return `{"status":"ok","service":"mekiri-proxy-daemon"}`.
- Active rules are stored in `~/.mekiri-proxy/rules.json` (overridable via `MEKIRI_PROXY_STATE_DIR`).
- A live smoke test against the real API — `npm run test:live` in `packages/mekiri-proxy` (not run by default, requires real billing).
