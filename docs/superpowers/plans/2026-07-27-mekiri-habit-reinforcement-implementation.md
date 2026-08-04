# Mekiri Habit Reinforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real usage gap found by self-audit on 2026-07-27: strengthen the in-session reflex to actually use `prune`/`sprout` (not just deliberate about them) inside `mekiri-host`, and give the controlling/orchestrating agent (not itself hosted by `mekiri-host`) its own habit mechanism — a project-local skill that starts/reuses a live `mekiri-host` session and routes real supervised work through its `sprout` tool instead of a generic Task subagent.

**Architecture:** Two independent parts. Part A modifies existing `mekiri-host` prompt-layer content (`MEKIRI_SYSTEM_PROMPT` in `permissions.ts`, `mekiri-gate/SKILL.md`) with a blunt reflex mantra, proven with a live behavioral test. Part B adds a new project-local Claude Code skill (`.claude/skills/mekiri-orchestrator/`) with two shell scripts (start/detect a live session; send it a task) plus a short `CLAUDE.md` pointing to it — this is orchestration tooling for the controlling agent itself, not `mekiri-host` application code, so it has no Vitest coverage; it's verified by direct execution.

**Tech Stack:** TypeScript (Part A, existing Vitest suite), Bash (Part B, no test framework — manual verification).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-mekiri-habit-reinforcement-design.md`.
- Part A must not remove or weaken the existing `mekiri-gate` nuance (e.g. Question 1's veto on forking at all when live user correction is needed) — the new mantra is an additive fast-path, not a replacement.
- Part B's scripts must work for the current project (`/home/pol/dev/rollback`) and generalize to any other absolute project path on this machine (parameterized, not hardcoded to one project).
- **Known collision to resolve before testing Part B for real**: a live `mekiri-host` session for `/home/pol/dev/rollback` was already started manually earlier in this same work session (no pidfile, since it predates this script). Before running `ensure-running.sh /home/pol/dev/rollback` for the first time, that manual process must be stopped (find it via `ps aux | grep "tail -f.*in.fifo"`, kill the `bash -c` wrapper PID), or `ensure-running.sh` will not detect it as running and will start a second reader on the same FIFO, causing message delivery to alternate unpredictably between the two readers.
- No new package. Part A stays in `packages/mekiri-host`; Part B lives in `.claude/skills/` and the repo root.

---

### Task 1: Part A — hard-gate reflex in `MEKIRI_SYSTEM_PROMPT` and `mekiri-gate`

**Files:**
- Modify: `packages/mekiri-host/src/permissions.ts:54-78` (the `MEKIRI_SYSTEM_PROMPT` string)
- Modify: `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`
- Test: `packages/mekiri-host/test/repl.smoke.test.ts` (new live smoke test)

**Interfaces:**
- Consumes: `createMekiriTools`, `buildQueryOptions`, `createAsyncSproutLimiter`, `createClaudeCodeBackend`, `createInputQueue` — all already imported in `repl.smoke.test.ts` (see its current import block).
- Produces: nothing new for later tasks — Task 2 is fully independent of this task.

- [ ] **Step 1: Strengthen `MEKIRI_SYSTEM_PROMPT`**

In `packages/mekiri-host/src/permissions.ts`, find:
```ts
You also have two Mekiri-specific skills available: mekiri-gate and
mekiri-tuning. Check mekiri-gate before any non-trivial decision about how
to dispatch work -- prune, sprout, a clean subagent, or staying inline.
Check mekiri-tuning whenever the user states an explicit priority about
Mekiri's own behavior, or when reviewing .mekiri/audit.jsonl shows a
sustained signal. Do not skip these because a decision "feels obvious" --
that is exactly when the gate is easiest to skip and most useful to apply.

This host currently only auto-approves Mekiri's own tools and read-only
tools (Read/Grep/Glob); Bash, Edit, Write, and any other MCP tool are
denied.`;
```
Replace with:
```ts
You also have two Mekiri-specific skills available: mekiri-gate and
mekiri-tuning. Check mekiri-gate before any non-trivial decision about how
to dispatch work -- prune, sprout, a clean subagent, or staying inline.
Check mekiri-tuning whenever the user states an explicit priority about
Mekiri's own behavior, or when reviewing .mekiri/audit.jsonl shows a
sustained signal. Do not skip these because a decision "feels obvious" --
that is exactly when the gate is easiest to skip and most useful to apply.

HARD RULE, not a suggestion: the moment you notice your own context has
gotten dirty (a dead end explored, garbage that won't help going forward)
-- prune. The moment before you are about to make it dirty with a subtask
-- sprout first, don't do the subtask inline and clean up after. This
applies even mid-turn, not just at the start of a new task.

This host currently only auto-approves Mekiri's own tools and read-only
tools (Read/Grep/Glob); Bash, Edit, Write, and any other MCP tool are
denied.`;
```

- [ ] **Step 2: Add the mantra to `mekiri-gate/SKILL.md`**

In `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`, find:
```markdown
# mekiri-gate

Гейт выбора инструмента диспетчеризации внутри mekiri-host: `prune` / `sprout` / чистый субагент (Task) / инлайн-работа. Применяется одинаково и родительской сессией, и любым sprout-клоном.

## Три вопроса по порядку (перед тем как начать)
```
Replace with:
```markdown
# mekiri-gate

Гейт выбора инструмента диспетчеризации внутри mekiri-host: `prune` / `sprout` / чистый субагент (Task) / инлайн-работа. Применяется одинаково и родительской сессией, и любым sprout-клоном.

**Быстрый рефлекс**: испачкался — `prune`. Собираешься пачкаться подзадачей — `sprout`. Ниже — полный гейт для случаев, где это неочевидно (в частности, вопрос 1 может вообще запретить форк).

## Три вопроса по порядку (перед тем как начать)
```

- [ ] **Step 3: Write the live behavioral proof test**

Read `packages/mekiri-host/test/repl.smoke.test.ts` in full first (it's long — use this to find the exact existing `describe("mekiri-host live smoke test: sprout/harvest end-to-end from the parent's real tool wiring", ...)` block, since this new test copies its parent-session-seeding pattern). This test proves the mantra actually changes behavior, not just text -- the model gets a task shaped exactly like `mekiri-gate`'s own "needs full inherited context, wants isolation, one final report" sprout example, is never told which tool to use, and the test asserts a real `mcp__mekiri__sprout` tool call appears in the message stream (not just narration about what it would do -- that's already covered by the existing "system prompt steers dispatch behavior" test in this same file, which explicitly forbids tool calls to test narration only; this new test is the complementary "does it actually act" proof).

Add this new `describe` block at the end of the file:
```ts
describe("mekiri-host live smoke test: hard-gate reflex actually fires sprout, not just narration", () => {
  it("calls sprout for a task needing full inherited context, without being told which tool to use", async () => {
    const dir = process.cwd();
    let parentSessionId: string | undefined;

    const tools = createMekiriTools({
      dir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => {
        if (!parentSessionId) throw new Error("no parent session id yet");
        return parentSessionId;
      },
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("prune should not be called -- this task doesn't involve a dead end");
      },
      onHarvest: () => {
        throw new Error("harvest should not be called from the parent in this test");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    });

    // Establish a real parent session id the same way repl.ts does: run one
    // trivial turn and read session_id off the system/init message (same
    // pattern as the existing sprout/harvest end-to-end test above).
    const seed = createInputQueue();
    seed.push("Reply with exactly one word: ok");
    seed.close();
    const seedQuery = query({
      prompt: seed.iterable,
      options: buildQueryOptions({ resume: undefined, cwd: dir, mcpServers: { mekiri: tools } }),
    });
    for await (const message of seedQuery) {
      if (message.type === "system" && message.subtype === "init") {
        parentSessionId = message.session_id;
      }
    }
    expect(parentSessionId).toBeTruthy();

    // Task shaped exactly like mekiri-gate's own sprout example ("Разберись
    // с этим багом, пока я продолжаю фичу" -- needs the parent's full
    // current understanding, wants isolation, one final report) -- not the
    // "check unrelated docs" example, which the gate's own table assigns to
    // a clean subagent instead.
    const { iterable, push, close } = createInputQueue();
    push(
      [
        "Разберись с багом в парсере конфига этого проекта и почини его, используя весь контекст проекта, который у тебя уже есть -- я пока продолжаю параллельно работать над документацией в другом месте и не хочу видеть сам процесс разбора, только финальный результат.",
        "Реши сам, каким инструментом лучше это сделать, и действуй -- никто не подсказывает тебе конкретный инструмент.",
      ].join("\n"),
    );
    close();

    let sproutCalled = false;
    const q = query({
      prompt: iterable,
      options: buildQueryOptions({ resume: parentSessionId, cwd: dir, mcpServers: { mekiri: tools } }),
    });
    for await (const message of q) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && block.name === "mcp__mekiri__sprout") {
            sproutCalled = true;
          }
        }
      }
      if (sproutCalled) {
        await q.return(undefined);
        break;
      }
    }

    expect(sproutCalled).toBe(true);
  }, 90_000);
});
```

- [ ] **Step 4: Run the new test**

Run: `npm run test --workspace=mekiri-host -- repl.smoke -t "hard-gate reflex"`
Expected: PASS (1 test). This is a real, billed live call. If it fails because the model chose a clean Task subagent or stayed inline instead of calling `sprout`, that's a real finding about the prompt wording's effectiveness, not a flaky test to retry blindly -- read the actual assistant text in the failure output to see what the model said and reasoned, and consider whether the task framing or the system-prompt wording needs adjusting before re-running.

- [ ] **Step 5: Run the full mekiri-host suite**

Run: `npm run test --workspace=mekiri-host`
Expected: PASS, all files, no regressions from the system-prompt/skill text changes (the existing "system prompt steers dispatch behavior" test explicitly forbids tool calls and only checks narration text containing "mekiri-gate" -- confirm it still passes, since the mantra addition must not make the model skip straight to narrating a *different* skill name or dropping the mention).

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/permissions.ts packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "feat(mekiri-host): strengthen the prune/sprout reflex in the system prompt and mekiri-gate"
```

---

### Task 2: Part B — `mekiri-orchestrator` skill + `CLAUDE.md`

**Files:**
- Create: `.claude/skills/mekiri-orchestrator/SKILL.md`
- Create: `.claude/skills/mekiri-orchestrator/scripts/ensure-running.sh`
- Create: `.claude/skills/mekiri-orchestrator/scripts/send.sh`
- Create: `/home/pol/dev/rollback/CLAUDE.md`

**Interfaces:**
- Consumes: nothing from Task 1 (fully independent).
- Produces: nothing consumed by a later task in this plan -- this is the last task.

- [ ] **Step 1: Stop the pre-existing manual live session first**

Before writing or testing anything in this task, find and stop the manually-started live `mekiri-host` session for `/home/pol/dev/rollback` (started earlier in this work session, before this skill existed -- it has no pidfile, so the new script below cannot detect it as already-running):
```bash
ps aux | grep "tail -f.*in.fifo" | grep -v grep
```
Note the PID of the `bash -c "tail -f ... | npx tsx ..."` wrapper process (the one whose command line contains `/home/pol/dev/rollback/.mekiri/live-session/in.fifo`), then:
```bash
kill <that PID>
```
Verify it's gone: re-run the `ps aux` command above and confirm no matching process remains. This is a one-time cleanup step for this task, not part of the skill's own scripts.

- [ ] **Step 2: Write `ensure-running.sh`**

Create `.claude/skills/mekiri-orchestrator/scripts/ensure-running.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:?usage: ensure-running.sh <project-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEKIRI_HOST_DIR="$(cd "$SCRIPT_DIR/../../../../packages/mekiri-host" && pwd)"

SESSION_DIR="$PROJECT_DIR/.mekiri/live-session"
FIFO="$SESSION_DIR/in.fifo"
LOG="$SESSION_DIR/output.log"
PIDFILE="$SESSION_DIR/pid"

mkdir -p "$SESSION_DIR"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: pid=$(cat "$PIDFILE") fifo=$FIFO log=$LOG"
  exit 0
fi

[ -p "$FIFO" ] || mkfifo "$FIFO"
: > "$LOG"

(
  cd "$MEKIRI_HOST_DIR"
  nohup bash -c "tail -f '$FIFO' | npx tsx src/index.ts --dir '$PROJECT_DIR'" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
)

echo "started: pid=$(cat "$PIDFILE") fifo=$FIFO log=$LOG"
```

Make it executable:
```bash
chmod +x .claude/skills/mekiri-orchestrator/scripts/ensure-running.sh
```

- [ ] **Step 3: Write `send.sh`**

Create `.claude/skills/mekiri-orchestrator/scripts/send.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:?usage: send.sh <project-dir> <message>}"
MESSAGE="${2:?usage: send.sh <project-dir> <message>}"
FIFO="$PROJECT_DIR/.mekiri/live-session/in.fifo"

if [ ! -p "$FIFO" ]; then
  echo "no live session fifo at $FIFO -- run ensure-running.sh first" >&2
  exit 1
fi

echo "$MESSAGE" >> "$FIFO"
```

Make it executable:
```bash
chmod +x .claude/skills/mekiri-orchestrator/scripts/send.sh
```

- [ ] **Step 4: Write the skill document**

Create `.claude/skills/mekiri-orchestrator/SKILL.md`:
```markdown
---
name: mekiri-orchestrator
description: "Use before dispatching subagent-shaped work (implementation, research, review) that is supervised and produces one final result, in a project where mekiri-host is available (this repo, or another project path on this machine) -- checks for or starts a live sprout-capable mekiri-host session and prefers routing real work through its sprout tool over a generic Task subagent, per this project's dogfood-asap standing instruction."
---

# mekiri-orchestrator

Перед тем как диспетчировать supervised-задачу с одним финальным результатом через обычный Task-субагент — проверь, есть ли живая, sprout-способная mekiri-host-сессия для целевого проекта, и предпочти её.

## Как использовать

1. Убедиться, что сессия жива (запускает, если нет):
   ```bash
   .claude/skills/mekiri-orchestrator/scripts/ensure-running.sh <project-dir>
   ```
   Идемпотентно: если уже запущена — просто печатает пути; если нет — поднимает и печатает пути.

2. Отправить реальную задачу:
   ```bash
   .claude/skills/mekiri-orchestrator/scripts/send.sh <project-dir> "текст задачи"
   ```

3. Прочитать результат из лога:
   ```
   <project-dir>/.mekiri/live-session/output.log
   ```
   (использовать `tail`/периодическую проверку, не блокирующее ожидание — та же живая сессия остаётся открытой для следующей задачи).

## Когда НЕ использовать

Если задача не подходит под форму «супервизируемая задача с одним финальным отчётом» (нужна параллельная работа нескольких независимых веток одновременно, или задача существенно проще одного sprout-вызова) — обычный Task-субагент по-прежнему уместен. Если решаешь не использовать эту сессию для реальной задачи — скажи это явно в ответе пользователю, а не молчаливо возвращайся к дефолту.
```

- [ ] **Step 5: Write the repo-root `CLAUDE.md`**

Create `/home/pol/dev/rollback/CLAUDE.md`:
```markdown
# Mekiri — agent instructions

This is the Mekiri project itself (context-hygiene tool for AI agents; see whitepaper.md and tz.md for the full design).

Before dispatching subagent-shaped work (implementation, research, review) that is supervised and produces one final result, check the `mekiri-orchestrator` skill -- it starts or reuses a live `mekiri-host` session and prefers routing real work through its `sprout` tool over a generic Task subagent, per this project's standing dogfooding policy. Fall back to a generic subagent only when that's genuinely impractical for the task's shape, and say so explicitly rather than defaulting silently.
```

- [ ] **Step 6: Verify `ensure-running.sh` for real (idempotency check)**

Run it twice in a row for this project:
```bash
.claude/skills/mekiri-orchestrator/scripts/ensure-running.sh /home/pol/dev/rollback
```
Expected first run: `started: pid=<N> fifo=/home/pol/dev/rollback/.mekiri/live-session/in.fifo log=/home/pol/dev/rollback/.mekiri/live-session/output.log`.

```bash
.claude/skills/mekiri-orchestrator/scripts/ensure-running.sh /home/pol/dev/rollback
```
Expected second run: `already running: pid=<same N> ...` (the same PID as the first run, proving idempotency).

- [ ] **Step 7: Verify `send.sh` for real (message delivery check)**

```bash
.claude/skills/mekiri-orchestrator/scripts/send.sh /home/pol/dev/rollback "Reply with exactly the string ORCHESTRATOR_SCRIPT_OK and nothing else."
sleep 15
tail -n 20 /home/pol/dev/rollback/.mekiri/live-session/output.log
```
Expected: the log contains `ORCHESTRATOR_SCRIPT_OK`. This is a real, billed live call (the session is a real `query()` loop) -- if the string doesn't appear within 15 seconds, wait a bit longer and check again before concluding it failed (a first turn on a freshly-started session may take longer to initialize than a resumed one).

- [ ] **Step 8: Commit**

```bash
git add .claude/skills/mekiri-orchestrator/SKILL.md .claude/skills/mekiri-orchestrator/scripts/ensure-running.sh .claude/skills/mekiri-orchestrator/scripts/send.sh CLAUDE.md
git commit -m "feat: add mekiri-orchestrator skill for routing real work through a live mekiri-host session"
```

---

## After this plan

Not covered here (see spec §5 «Вне скоупа»): full self-install of Mekiri from zero on a machine with no source present, for an arbitrary developer/project (needs a distribution decision -- git clone vs. npm publish -- naturally sequenced with the ACP portability work's own "any environment" goal); a stop/restart script for the live session (the known orphaned-child-process limitation in `ensure-running.sh` is accepted, not solved, since a stop script wasn't requested); any change to `mekiri-tuning`.
