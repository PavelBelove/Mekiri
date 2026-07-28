# mekiri-host: доверенный режим (`--trusted`) — design

**Дата:** 2026-07-28
**Скоуп:** дать живой `mekiri-host`-сессии реальные инструменты разработки (Bash/Edit/Write) наравне с гигиеной (prune/sprout), чтобы одна и та же сессия могла и писать/тестировать код, и сама, по ситуации, применять откат/тёплый клон — вместо сегодняшнего разделения «клон только исследует → ствол применяет фикс».

---

## 1. Зачем и почему сейчас разделено

`canUseTool` (`permissions.ts`) сегодня безусловно разрешает только `mcp__mekiri__*` (плюс read-only Read/Grep/Glob, которые SDK одобряет ещё до `canUseTool`); всё остальное — Bash, Edit, Write, любой другой MCP — запрещено с явным сообщением «mekiri-host is a minimal REPL that doesn't yet support interactive tool-permission prompts». Это было осознанным консервативным дефолтом на момент, когда `mekiri-host` был только read-only исследователем. Найденный сегодня практический разрыв: живая сессия физически не может сама закрыть цикл «нашёл баг → поправил → протестировал → откатил контекст расследования» — это всегда требует передачи стволу.

## 2. Архитектура

Новый флаг `--trusted` при запуске `mekiri-host` (`index.ts`). Без флага — поведение не меняется вообще (read-only исследователь, как сегодня). С флагом — `canUseTool` безусловно разрешает всё, включая Bash/Edit/Write; сессия становится полноценным разработчиком с сохранённым доступом к `prune`/`sprout`/`harvest`/`configure_mekiri`.

### 2.1. `canUseTool` — параметризация

`permissions.ts`: существующий экспорт `canUseTool` не трогается (обратная совместимость для мест, где он импортируется напрямую). Добавляется:
```ts
export function resolveCanUseTool(trusted: boolean): CanUseTool {
  if (trusted) {
    return async () => ({ behavior: "allow" });
  }
  return canUseTool;
}
```

### 2.2. Системный промпт — условная добавка, не переписывание

`MEKIRI_SYSTEM_PROMPT` остаётся неизменным текстом (существующие тесты его проверяют дословно). Добавляется отдельная константа, дописываемая только в доверенном режиме:
```ts
export const TRUSTED_MODE_ADDENDUM = `

TRUSTED MODE: you also have real Bash, Edit, and Write access in this
session -- work like any careful engineer would (run tests before
considering something done, read before you overwrite). This session runs
unattended, with nobody watching to approve or deny actions turn-by-turn --
so never perform irreversible or destructive operations (force-push,
rm -rf, deleting branches, git reset --hard, or anything comparable) even
if you'd normally ask first in an interactive session. If something
genuinely requires one of those, stop and report back instead of doing it.`;
```
`buildQueryOptions` строит итоговый `systemPrompt` как `MEKIRI_SYSTEM_PROMPT + (trusted ? TRUSTED_MODE_ADDENDUM : "")`.

### 2.3. Прокидывание флага

- `index.ts`: парсинг `--trusted` (булев флаг, без значения) наравне с `--dir`/`--resume`; попадает в `ReplOptions.trusted`.
- `repl.ts`: `ReplOptions` получает `trusted?: boolean` (по умолчанию `false`); передаётся в `buildQueryOptions({..., trusted: options.trusted ?? false})` и в `createMekiriTools({..., trusted: options.trusted ?? false})`.
- `tools.ts`: `MekiriToolsContext` получает `trusted: boolean`. `handleSprout`'s `buildTools`-замыкание передаёт `trusted: context.trusted` в контекст клона (то же значение, не настраивается по клону отдельно — это свойство всей сессии, не конкретного форка). `runClone` (сигнатура `clone.ts`) получает пятый параметр `trusted: boolean`, используемый в его собственном вызове `buildQueryOptions({..., trusted})`.
- `buildQueryOptions`'s `context`-параметр получает `trusted?: boolean` (по умолчанию `false` — чтобы существующие вызовы без этого поля, включая тесты, продолжали работать без изменений) и использует `resolveCanUseTool(context.trusted ?? false)` вместо жёстко зашитого `canUseTool`, плюс собирает `systemPrompt` по правилу §2.2.

## 3. Тестирование

- Юнит-уровень: `resolveCanUseTool(true)` разрешает произвольный `toolName` (включая `Bash`/`Edit`/`Write`), `resolveCanUseTool(false)` ведёт себя как существующий `canUseTool`.
- `buildQueryOptions({..., trusted: true})` даёт `systemPrompt`, содержащий `TRUSTED_MODE_ADDENDUM`; без `trusted` (или `trusted: false`) — не содержащий.
- Живое поведенческое доказательство (как и все предыдущие фичи этого дня): запустить реальную `--trusted`-сессию на настоящей задаче из бэклога (см. §5), подтвердить, что модель реально пишет/правит код через Edit/Bash И реально использует prune/sprout по ходу работы без подсказки — то есть именно то сочетание, ради которого всё затевалось.

## 4. Вне скоупа

- Полноценный интерактивный permission-prompt UI для `mekiri-host` (это отдельная, гораздо более крупная фича — «доверенный режим» сознательно обходит её, полагаясь на осторожность модели плюс явный запрет необратимых операций в промпте, а не на пользовательское подтверждение по каждому действию).
- Точечные разрешения/блок-листы конкретных Bash-команд — не делаем эвристический слой поверх `canUseTool`; доверенный режим — это действительно доверенный режим (то же самое доверие, что и обычной интерактивной Claude Code сессии этого же пользователя), не полумера.
- Изменения в `mekiri-gate`/`mekiri-tuning` — не нужны, их логика уже не зависит от того, какие инструменты физически доступны.
