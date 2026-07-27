# Mekiri: усиление привычки использования (habit reinforcement) — design

**Дата:** 2026-07-27
**Скоуп:** два независимых, но связанных изменения, найденных через самоаудит контроллирующего агента в этой же сессии — реальный разрыв между «инструмент работает» и «инструмент реально используется». Не включает полный self-install Mekiri с нуля на машине без исходников — это отдельная, более крупная задача, естественно идущая вместе с ACP-порт-задачей (см. §5 «Вне скоупа»).

---

## 1. Находка, из которой растёт эта спека

`sprout` был живо доказан рабочим ещё до начала феатуры ACP execution-backend (Task 4 той же феатуры прогнал реальный `handleSprout` end-to-end). Тем не менее весь рефакторинг (4 задачи, ~13 диспатчей implementer/reviewer) прошёл через обычный Agent tool (генерик Task-субагенты Claude Code), а не через специально поднятую для этого живую `mekiri-host`-сессию. `.mekiri/audit.jsonl` не получил ни одной новой записи за всё время — это и обнажило проблему при повторном прогоне `metricsCli`.

Два разных уровня одной проблемы:
- **Внутри mekiri-host-сессии**: у модели есть инструменты и гейт (`mekiri-gate`), но текущая формулировка системного промпта («check mekiri-gate before dispatch decisions») — это взгляд «до», не рефлекс «во время» реальной грязной работы.
- **На уровне оркестрирующего агента** (тот, кто ведёт эту самую беседу): системный промпт mekiri-host физически не достаёт до оркестратора — он не хостится mekiri-host'ом вообще. Это отдельная привычка, которую нужно закрепить другим механизмом.

## 2. Часть A — усиление рефлекса внутри mekiri-host

Правки существующих файлов, не новый параллельный скилл (нюанс `mekiri-gate`'а — например, вето вопроса 1 на форк, если нужна живая коррекция пользователя — не должен потеряться за новой мантрой).

### 2.1. `MEKIRI_SYSTEM_PROMPT` (`packages/mekiri-host/src/permissions.ts`)

Текущий текст оставляет фразу про `mekiri-gate` без изменений, но добавляет новый абзац сразу после неё — жёсткую, рефлекторную формулировку, ориентированную на «во время», а не только «до»:

```
HARD RULE, not a suggestion: the moment you notice your own context has
gotten dirty (a dead end explored, garbage that won't help going forward) --
prune. The moment before you are about to make it dirty with a subtask --
sprout first, don't do the subtask inline and clean up after. This applies
even mid-turn, not just at the start of a new task.
```

### 2.2. `mekiri-gate/SKILL.md` (`packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`)

Первой строкой тела документа, перед существующим «Три вопроса по порядку» — короткая мантра на русском (документ и так на русском), с явной оговоркой, что она не отменяет нюанс ниже:

```
**Быстрый рефлекс**: испачкался — `prune`. Собираешься пачкаться подзадачей — `sprout`. Ниже — полный гейт для случаев, где это неочевидно (в частности, вопрос 1 может вообще запретить форк).
```

## 3. Часть B — скилл-оркестратор для контроллирующего агента

Новый **проектный** скилл (не маркетплейсный, `.claude/skills/`, обнаруживается тем же механизмом, что и любой другой скилл в листинге) — потому что системный промпт mekiri-host не может дотянуться до оркестратора; ему нужен свой, отдельный механизм привычки.

### 3.1. `.claude/skills/mekiri-orchestrator/SKILL.md`

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

### 3.2. `scripts/ensure-running.sh`

Использует ровно тот же паттерн (FIFO + `nohup` + `tail -f`), что уже был вручную проверен живьём в этой сессии 2026-07-27, только обобщённый параметром `<project-dir>` и с добавленным pid-файлом для идемпотентной проверки:

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

`MEKIRI_HOST_DIR` резолвится относительно расположения самого скрипта (`.claude/skills/mekiri-orchestrator/scripts/` → вверх 4 уровня → корень репозитория → `packages/mekiri-host`) — скилл живёт внутри этого репозитория и всегда использует уже собранный здесь `mekiri-host`, независимо от того, какой `<project-dir>` он обслуживает.

**Известное ограничение, не решается в этой фазе**: `kill` по pid из pidfile убивает сам bash-процесс обёртки, но не гарантированно убивает дочерние `tail`/`node` процессы (они могут остаться сиротами). Скрипт для остановки сессии не запрашивался и не входит в этот скоуп — если понадобится, это отдельная, самостоятельная задача.

### 3.3. `scripts/send.sh`

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

### 3.4. `/home/pol/dev/rollback/CLAUDE.md` (новый файл, сейчас отсутствует)

Короткий, не дублирует whitepaper.md/tz.md — просто указывает на скилл для надёжности обнаружения (белт-энд-сасподерс поверх обычного механизма листинга скиллов):

```markdown
# Mekiri — agent instructions

This is the Mekiri project itself (context-hygiene tool for AI agents; see whitepaper.md and tz.md for the full design).

Before dispatching subagent-shaped work (implementation, research, review) that is supervised and produces one final result, check the `mekiri-orchestrator` skill -- it starts or reuses a live `mekiri-host` session and prefers routing real work through its `sprout` tool over a generic Task subagent, per this project's standing dogfooding policy. Fall back to a generic subagent only when that's genuinely impractical for the task's shape, and say so explicitly rather than defaulting silently.
```

## 4. Тестирование

- **Часть A** — тестируется так же, как предыдущая system-prompt-фича: живой прогон, где модели внутри mekiri-host-сессии даётся задача, естественно приводящая к грязному контексту или к решению о диспетчеризации подзадачи, БЕЗ явного упоминания prune/sprout — и проверяется, что модель реально вызывает нужный инструмент, а не просто упоминает его в тексте.
- **Часть B** — в этом репозитории нет фреймворка для тестирования bash-скриптов (не Vitest-объект); проверяется прямым запуском: (1) `ensure-running.sh` дважды подряд — первый раз стартует, второй раз идемпотентно определяет «уже запущено»; (2) `send.sh` реально доставляет сообщение — подтверждается появлением ответа в `output.log`. Это ручная верификация, не автоматический тест-сьют — как и сама живая FIFO-сессия, уже поднятая вручную сегодня.
- Финальная приёмка — не синтетика: после того как эта феатура смержена, следующая реальная задача в проекте должна быть реально продиспетчирована через `mekiri-orchestrator` (не просто скрипты запущены и брошены), и повторный прогон `metricsCli` должен показать новую, отличную от текущей, запись в `.mekiri/audit.jsonl`.
- **Известная коллизия, которую нужно устранить перед первым реальным тестом `ensure-running.sh`**: в этой же сессии сегодня уже вручную поднята живая сессия для `/home/pol/dev/rollback` (тот же `.mekiri/live-session/`, но без pid-файла — она создавалась не через этот скрипт). Первый реальный запуск `ensure-running.sh /home/pol/dev/rollback` не увидит pid-файл и попытается поднять вторую сессию поверх того же FIFO — два `tail -f` на одном именованном канале дают непредсказуемое чередование доставки сообщений между читателями. Перед тестированием этой части — остановить вручную поднятый процесс (`kill` по PID, найденному через `ps aux | grep "tail -f.*in.fifo"`), только после этого гонять `ensure-running.sh` по-настоящему.

## 5. Вне скоупа

- Полный self-install Mekiri с нуля (без исходников на машине, для произвольного разработчика/проекта) — требует ещё не принятого решения о способе дистрибуции (git clone? npm publish?). По смыслу пересекается с «любая среда» из ACP-порт-задачи — рассматривать вместе с ней, не раньше.
- Скрипт остановки/перезапуска живой сессии (см. известное ограничение в §3.2) — не запрашивался.
- Любые изменения в `mekiri-tuning` (Trigger B и её метрики) — не предмет этой феатуры.
