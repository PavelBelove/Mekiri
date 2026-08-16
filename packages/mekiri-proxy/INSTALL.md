# Installing Mekiri into a third-party project

This guide is aimed at an agent that has been given a link to this repository and is setting up Mekiri on its own, without a dialogue with a human, in **another** project (referred to below as the "target project"). Mekiri is not copied into the target project — it's cloned separately, once, and reused for any number of target projects via absolute paths.

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
```

`npm run typecheck` should pass without errors — this confirms the build is working before wiring it into the target project.

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

Add this line to the environment where Claude Code starts for the target project (`~/.bashrc`, `~/.zshrc`, IDE environment variables — depending on where the session is launched from). The variable is read **once at process startup** — if a session for the target project is already open, restart it after setting the variable.

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

Copy the three skills from `<MEKIRI_DIR>/.claude/skills/` into `.claude/skills/` in the target project:

```bash
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-gate .claude/skills/
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-orchestrator .claude/skills/
cp -r <MEKIRI_DIR>/.claude/skills/mekiri-tuning .claude/skills/
```

`mekiri-orchestrator` also references its own `scripts/*.sh` (`ensure-running.sh`, `send.sh`) — they take the project path as an argument and don't hardcode Mekiri's location, but on first real use it's worth checking once that the scripts can find the right binaries in your environment.

## 6. `CLAUDE.md` in the target project (optional)

To make the agent in the target project understand on its own when to call Mekiri's tools, add a short fragment to its `CLAUDE.md`, for example:

```markdown
Whenever a closed micro-episode of work ends (a file read for one question,
one test suite run, one verdict reached) and the mekiri-proxy MCP tools are
available — check the mekiri-gate skill before continuing: don't wait for
the whole task to end, and don't batch several episodes together.
```

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
