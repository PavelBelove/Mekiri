---
name: mekiri-tuning
description: "Use when the user states an explicit priority about Mekiri's own behavior (token efficiency, sprout depth, parallelism, wait mode), or when reviewing .mekiri/audit.jsonl and prune/sprout metrics show a sustained signal. Governs how and when to call configure_mekiri -- never silently."
---

# mekiri-tuning

Протокол смены `.mekiri/config.json` (`sprout.depth_limit`, `sprout.parallelism`, `sprout.wait_mode`, `priorities.token_efficiency`) через тулзу `configure_mekiri`. Применяется одинаково родителем и любым клоном.

## Триггер A — явный приоритет пользователя

Пользователь прямо заявляет приоритет: например «токены не важны, дай больше глубины/деталей», «сделай sprout глубже», «экономь агрессивно». Реакция — немедленный вызов:

```
configure_mekiri(patch: <изменение>, reason: "user_override: <кратко что сказал пользователь>")
```

Без отчёта и без вопроса — сам факт явного заявления уже есть согласие.

## Триггер B — накопленный сигнал метрик

Источник — **только** `.mekiri/audit.jsonl` в корне проекта (JSON Lines, читай напрямую через Read/Bash — не через API, такого API нет). Каждая строка — одна из: `{"event":"prune", removedBranchLength, fruitLength, ...}`, `{"event":"sprout", branchLength, harvestLength, ...}`, `{"event":"configure_mekiri", ...}`.

Считаются только две метрики (остальные формулы из tz.md §12.2 требуют анализа сессионных файлов, которого у тебя нет при чтении одного `audit.jsonl`):

- **Distillation Ratio** (по каждой `prune`-записи) = `removedBranchLength / fruitLength`.
- **Branch Compression** (по каждой `sprout`-записи) = `branchLength / harvestLength`.

Плейсхолдер-пороги (условные, для калибровки по мере накопления реальных данных — не догма):

| Сигнал | Порог |
|---|---|
| Устойчиво низкая дистилляция | ≥3 подряд `prune`-записи со средним Distillation Ratio < 2× |
| Устойчиво низкое сжатие клонов | ≥2 подряд `sprout`-записи со средним Branch Compression < 2× |
| Упёрлись в потолок рекурсии | `sprout` только что вернул `{"status": "depth_limit_exceeded"}` в этом самом ходе (не ищи это в логе — такие попытки туда не пишутся) |

**Правило:** ни один сигнал из Триггера B не приводит к молчаливой правке. Реакция — короткий отчёт с конкретными цифрами (какая метрика, какое значение, за какой период) и прямой вопрос «что делаем». Только после ответа — `configure_mekiri(..., reason: "metric_signal: <что показали цифры>")`.

## Оговорка про контакт с пользователем

Шаг «спросить» из Триггера B требует живого контакта с пользователем прямо сейчас:

- Если контакт есть (например, ты в интерактивном REPL) — спроси напрямую, как описано выше.
- Если контакта нет (например, ты работаешь автономно как sprout-клон и до `harvest` не общаешься с пользователем) — не применяй правку самостоятельно. Вынеси наблюдение в свой обычный `harvest`-результат как часть дистиллята, оставив решение тому, у кого есть контакт с пользователем.

Триггер A в этой оговорке не нуждается: если пользователь прямо сказал что-то клону через `task` при вызове `sprout`, контакт уже состоялся через родителя.
