# Installing Mekiri into a third-party project

This guide is aimed at an agent that has been given a link to this repository and is setting up Mekiri on its own, without a dialogue with a human, in **another** project (referred to below as the "target project"). Mekiri is not copied into the target project — it's cloned separately, once, and reused for any number of target projects via absolute paths.

**Self-hosting Mekiri on itself** (cloning this repo and using it on its own repo, with no other project involved) doesn't need this guide at all — see the [README's Self-hosting section](../../README.md#self-hosting-mekiri-on-itself) instead; `.mcp.json`, `.claude/settings.json`, `CLAUDE.md`, and `.claude/skills/*` all ship already-correct for that case.

> **Any change below — `.mcp.json` (§2), `ANTHROPIC_BASE_URL` (§3), `.claude/settings.json` (§4), or `.claude/skills/` (§5) — requires a full Claude Code session restart to take effect, not just the env var.** All of them are read once at process startup. If you edit one mid-session and see no error, that's not confirmation it worked — it means you're still running on the old wiring. Self-check: if a skill you just copied in doesn't show up in your available-skills list, you haven't restarted yet.

## 0. Check the Node version

`nudge-hook.ts` runs via `node --experimental-strip-types` — this flag needs **Node ≥ 22.6**.

```bash
node --version
```

If the version is lower — upgrade Node (e.g. via `nvm install 22`) before continuing; an older Node won't be able to run the hook, and the `prune`/`sprout` reminders simply won't work.

## 1. Clone and smoke-test

Clone Mekiri into a stable location outside the target project (e.g. `~/dev/Mekiri` or `~/tools/Mekiri`) — the path will be needed in literally every following step:

```bash
git clone https://github.com/PavelBelove/Mekiri.git ~/dev/Mekiri
cd ~/dev/Mekiri
npm install
npm run typecheck
npm run test --workspaces
```

`npm run typecheck` should pass without errors, and the full test suite (~20s, both workspaces) should pass too — typecheck alone catches far less than a real test run. This confirms the build is working before wiring it into the target project.

`npm audit` will report about 10 findings, including one "critical" — all of them are in the `vitest`/`vite` devDependency chain, not the runtime MCP server/daemon. That's expected, not a sign the clone is broken.

Below, `<MEKIRI_DIR>` refers to the absolute path to this clone (e.g. `/home/user/dev/Mekiri`).

## 2. `.mcp.json` in the target project

In the root of the **target project**, create or extend `.mcp.json`:

```json
{
  "mcpServers": {
    "mekiri-proxy": {
      "command": "npx",
      "args": ["tsx", "<MEKIRI_DIR>/packages/mekiri-proxy/bin/mcp-server.ts"]
    }
  }
}
```

The path must be **absolute** — unlike the Mekiri repository itself (where `.mcp.json` uses a relative path for the self-hosting scenario), the target project doesn't live inside Mekiri, and a relative path won't work here.

## 3. `ANTHROPIC_BASE_URL`

Mekiri intercepts outgoing requests to the Anthropic API through a local proxy daemon. Claude Code must send requests through it:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8791"
```

Add this line to the environment where Claude Code starts for the target project. Where depends on how it's launched:

- **From an interactive shell** (typing `claude` in a terminal): add the line to `~/.bashrc` or `~/.zshrc`.
- **From a GUI or IDE extension** (desktop icon, VS Code, JetBrains): shell rc files are *not* sourced. On Linux with systemd, use a user-environment drop-in instead:
  ```bash
  mkdir -p ~/.config/environment.d
  echo 'ANTHROPIC_BASE_URL=http://127.0.0.1:8791' > ~/.config/environment.d/mekiri-proxy.conf
  ```
  This needs a full **re-login** (or `systemctl --user import-environment ANTHROPIC_BASE_URL` in the current login session) to take effect — restarting just Claude Code is not enough for this path. If you're not on systemd, use whatever mechanism your IDE/launcher exposes for process environment variables.

The variable is read **once at process startup** — if a session for the target project is already open, restart it after setting the variable. If `/health` still doesn't respond after restarting Claude Code in a GUI/IDE launch, the next thing to check is whether the *login session* itself needs restarting, not just Claude Code.

## 4. `.claude/settings.json` in the target project

Add (or extend, if the file already exists) in the target project:

```json
{
  "enabledMcpjsonServers": ["mekiri-proxy"],
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node --experimental-strip-types \"<MEKIRI_DIR>/packages/mekiri-proxy/bin/nudge-hook.ts\""
          }
        ]
      }
    ]
  }
}
```

The path in the hook is also absolute, with the same `<MEKIRI_DIR>`. Don't use `$CLAUDE_PROJECT_DIR` here: this variable resolves to the root of the **target** project, not to the directory where the cloned Mekiri lives — if Mekiri is cloned separately (as recommended in step 1), `$CLAUDE_PROJECT_DIR/packages/mekiri-proxy/...` will point nowhere.

## 5. Skills

Copy all four skills from `<MEKIRI_DIR>/.claude/skills/` into `.claude/skills/` in the target project:

```bash
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-gate .claude/skills/
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-orchestrator .claude/skills/
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-tuning .claude/skills/
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-warmup .claude/skills/
```

`mekiri-orchestrator` also references its own `scripts/*.sh` (`ensure-running.sh`, `send.sh`) — they take the project path as an argument and don't hardcode Mekiri's location, but on first real use it's worth checking once that the scripts can find the right binaries in your environment.

## 6. `CLAUDE.md` in the target project

Not optional — without this, the target project's agent has no way to know these tools exist or when to reach for them; the MCP wiring alone doesn't teach that.

`<MEKIRI_DIR>/CLAUDE.md` has three trigger paragraphs, each naming a condition and ending in "check the `mekiri-X` skill" (for `mekiri-orchestrator`, `mekiri-gate`, `mekiri-warmup`). They're written generically ("this project", "this session") and are portable as-is. Everything else in that file — the "respond in Russian" line, the "# Mekiri — agent instructions" header, the "this is the Mekiri project itself" description — is specific to this repository and must be skipped.

- **If the target project already has a `CLAUDE.md`**, append the three trigger paragraphs to it (don't overwrite anything already there).
- **If it doesn't**, create one containing just those three paragraphs.

## 7. Verification

After restarting Claude Code in the target project with `ANTHROPIC_BASE_URL` applied:

```bash
curl http://127.0.0.1:8791/health
```

Expected response: `{"status":"ok","service":"mekiri-proxy-daemon"}`. The daemon comes up automatically on the first call to any Mekiri tool — no need to start it manually.

## Troubleshooting

| Symptom | Check |
|---|---|
| `curl .../health` doesn't respond | The daemon hasn't come up yet — call any Mekiri tool (e.g. `metrics`) and check again. If that doesn't help — look at the daemon log in `~/.mekiri-proxy/`. |
| `nudge-hook.ts` hook fails with a syntax error | Node version below 22.6 (see step 0) — the `--experimental-strip-types` flag isn't supported. |
| The `prune`/`sprout`/... MCP tools aren't visible in the session | Check that `mekiri-proxy` is listed in `enabledMcpjsonServers` in `.claude/settings.json`, and that the session was restarted after editing `.mcp.json`. |
| `prune` returns `not_found`/`ambiguous` | Standard behavior of the quote-based addressing protocol, not an install bug — see [`../../docs/mechanics/architecture.md`](../../docs/mechanics/architecture.md#quote-boundary-addressing). |
| Things work but not the way this clone's code should behave (e.g. after pulling a fix) | Another Mekiri clone's daemon may already own port 8791 and be silently serving every project on the machine. Check `curl .../health` for `pid`/`sourceDir` and compare against `ps aux \| grep mekiri-proxy` — see [`../../docs/mechanics/architecture.md`](../../docs/mechanics/architecture.md#the-daemon-is-one-process-per-machine). |
