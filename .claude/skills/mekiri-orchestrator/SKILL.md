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
