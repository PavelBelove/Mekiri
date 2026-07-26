# mekiri-host system prompt layer — design

**Дата:** 2026-07-26
**Скоуп:** закрыть gap, зафиксированный при работе над `mekiri-gate`/`mekiri-tuning` — `query()` в `mekiri-host` сейчас не задаёт `systemPrompt`, поэтому у хостируемого агента нет базовых, стабильных, role-independent правил (layer 1 из `[[feedback-mekiri-prompt-layering]]`), отдельных от скиллов (layer 2) и sprout-time инжекта (layer 3).

---

## 1. Механизм

`systemPrompt: <plain string>` — полная замена дефолта SDK, не `{type:'preset', preset:'claude_code', append}`. `mekiri-host` не Claude Code CLI и не пытается им быть (нет интерактивных permission-промптов, слэш-команд и прочих допущений `claude_code`-пресета) — использование пресета притащило бы не относящийся к делу контекст. Не `string[]` с `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` — весь контент статичен, кеш-boundary не нужен (YAGNI).

## 2. Где

Та же точка, что и для `plugins` (`docs/superpowers/specs/2026-07-25-mekiri-gate-tuning-design.md` §1): новая константа + одно поле в `buildQueryOptions()` (`packages/mekiri-host/src/permissions.ts`). Функция уже единая точка входа для `repl.ts` и `clone.ts` — родитель и любой клон получают промпт идентично, без дополнительных изменений в этих файлах.

## 3. Контент

Английский — это операционная инструкция про инструменты и окружение (по аналогии со всеми tool-descriptions в `tools.ts`, которые тоже на английском), а не содержательный текст скиллов, который остаётся русским, adaptированным из tz.md.

```
You are running inside mekiri-host, a minimal SDK-hosted REPL for the Mekiri
project -- a context-hygiene tool that lets you manage your own session
history directly, instead of relying only on automatic compaction.

In addition to your normal tools, you have four Mekiri-specific tools:
- prune(quote, note_type, fruit, keep_code) -- cut a dirty tail of this
  session and continue from a distilled note.
- sprout(task) -- fork a warm clone of this session to work a side task
  in isolation.
- harvest(result, needs_clean_look?) -- return a clone's result to its
  parent (only valid inside a sprout clone).
- configure_mekiri(patch, reason) -- patch Mekiri's own runtime config
  (.mekiri/config.json).

You also have two Mekiri-specific skills available: mekiri-gate and
mekiri-tuning. Check mekiri-gate before any non-trivial decision about how
to dispatch work -- prune, sprout, a clean subagent, or staying inline.
Check mekiri-tuning whenever the user states an explicit priority about
Mekiri's own behavior, or when reviewing .mekiri/audit.jsonl shows a
sustained signal. Do not skip these because a decision "feels obvious" --
that is exactly when the gate is easiest to skip and most useful to apply.

This host currently only auto-approves Mekiri's own tools and read-only
tools (Read/Grep/Glob); Bash, Edit, Write, and any other MCP tool are
denied.
```

Формулировка последнего абзаца первого блока про скиллы («не пропускай, потому что решение кажется очевидным») намеренно взята по прецеденту из скилла `using-superpowers` (та же логика, что форсирует проверку скиллов в этой самой CLI-сессии) — ровно тот случай из `[[feedback-mekiri-prompt-layering]]`, когда role-independent правилу нужно более настойчивое подкрепление, чем даёт сам скилл.

Промпт намеренно не дублирует содержимое скиллов (детали `note_type`, контрастные примеры, пороги tuning) — только идентификация окружения, инвентарь тулз, и императив проверять скиллы. Детали остаются в skill-контенте (layer 2), не размножаются в system prompt.

## 4. Тестирование

- **Wiring (юнит):** расширить `describe("buildQueryOptions", ...)` — `options.systemPrompt` равен ожидаемой строке. Тот же паттерн, что и для `plugins`.
- **Эффективность контента (живой поведенческий smoke-тест):** здесь главный риск не wiring (уже отработанный паттерн из `[[gate-tuning]]`), а работает ли контент. Даём модели неоднозначную диспетчерскую ситуацию без какой-либо другой подсказки (без явного упоминания prune/sprout/субагента) и проверяем, что она сама упоминает/применяет `mekiri-gate`, не будучи прямо об этом попрошенной. Это содержательное доказательство эффективности промпта, а не просто факт его наличия в `Options`.

## 5. Вне скоупа

- `hooks`-инфраструктура (`SessionStart` и т.п.) — альтернативный, более сильный механизм форсирования (как это делает `superpowers`-плагин через `SessionStart`-хук), но `mekiri-host` сейчас вообще не имеет `hooks`-wiring в `query()` (подтверждено live-дискофудингом при исследовании pre-compact snapshot, см. project-memory). Строить hooks-инфраструктуру ради одной инструкции — избыточно для этой итерации; system prompt с форсирующей формулировкой — минимальный достаточный механизм. Если после дискофудинга окажется недостаточно сильным, hooks — следующая эскалация, отдельная задача.
- Динамический/dependent-on-role контент в system prompt — запрещено правилом role-agnostic (layer 1 одинаков для родителя и клона); различие ролей остаётся в sprout-time инжекте (layer 3, уже реализовано в `handleSprout`'s `framedTask`).
