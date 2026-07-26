# mekiri-host hooks infrastructure — design

**Дата:** 2026-07-26
**Ветка:** `mekiri-hooks-infra` (изолированная worktree — по явному указанию владельца проекта: этот кусок работы остаётся вне `main`, пока не заработает вживую; в отличие от всех предыдущих итераций Mekiri, которые шли прямо в `main`).

**Скоуп:** первое использование `hooks` в `query()` — `Options.hooks` сейчас нигде не задействован ни в `repl.ts`, ни в `clone.ts` (подтверждено дважды: живым дискофудингом при исследовании pre-compact snapshot и повторно при работе над system prompt).

---

## 1. Почему не «SessionStart-хук как дубликат system prompt»

У `superpowers` (плагин) нет прямого доступа к `Options.systemPrompt` — этим управляет хост (Claude Code CLI), а не плагин, поэтому `SessionStart`-хук с `additionalContext` — единственный канал усилить инструкцию. У `mekiri-host` этот канал уже есть напрямую: `MEKIRI_SYSTEM_PROMPT` (`docs/superpowers/specs/2026-07-26-mekiri-host-system-prompt-design.md`) уже говорит агенту проверять `mekiri-gate`/`mekiri-tuning`. Повторение той же статичной инструкции через хук не добавляет силы — это дублирование контента без новой функции.

Настоящая уникальная способность хуков — не «настойчивее сказать то же самое», а то, что колбэк выполняется **живым кодом при каждом старте сессии** и может вычислить контекст по актуальному состоянию, чего статичный `systemPrompt` в принципе не может.

## 2. Реальный неавтоматизированный гэп: `mekiri-tuning`'s Trigger B

`mekiri-tuning` (skill, `packages/mekiri-host/skills-plugin/skills/mekiri-tuning/SKILL.md`) описывает Trigger B — накопленный сигнал метрик — но полностью полагается на то, что агент сам вспомнит прочитать `.mekiri/audit.jsonl` и посчитать формулы. Это первый реальный случай, где хук может закрыть автоматизацией то, что сейчас держится только на памяти агента, а не просто продублировать текст.

**Механика:** на старте каждой сессии (parent и любой clone — файл `audit.jsonl` общий для всего проекта) хук:
1. Читает `.mekiri/audit.jsonl` через `mekiri-core`'s `readAuditLog(dir)`.
2. Берёт только записи **после последнего `configure_mekiri`**-события в логе (если такое было) — anti-nag: иначе один и тот же сигнал будет всплывать на каждом старте сессии бесконечно, даже после того как пользователь уже отреагировал правкой конфига. Деградирует корректно: нет `configure_mekiri`-записей → берутся все записи.
3. Из оставшихся считает те же две метрики и те же плейсхолдер-пороги, что уже зафиксированы в скилле `mekiri-tuning` (не новые числа, те же самые — расхождение между скиллом и хуком было бы багом):
   - `prune`-записи: Distillation Ratio (`removedBranchLength / fruitLength`, `mekiri-core`'s `distillationRatio`) — сигнал при ≥3 подряд записях со средним < 2×.
   - `sprout`-записи: Branch Compression (`branchLength / harvestLength`, `mekiri-core`'s `branchCompression`) — сигнал при ≥2 подряд записях со средним < 2×.
4. Если хотя бы один сигнал сработал — возвращает `additionalContext` с конкретными цифрами (какая метрика, среднее значение, сколько записей) и явной отсылкой «см. `mekiri-tuning`, Trigger B». Если сигналов нет — `additionalContext` не заполняется (тишина по умолчанию, не шумим просто так).

Trigger A (явный приоритет пользователя) и внутрисессионный сигнал `depth_limit_exceeded` хуком не автоматизируются — оба принципиально не вычислимы на старте сессии из `audit.jsonl` (Trigger A — живое высказывание в разговоре; `depth_limit_exceeded` не пишется в лог вообще, см. `tools.ts:153-155`). Остаются как есть — на суждении агента.

## 3. Механизм (проверено по sdk.d.ts)

- `Options.hooks?.SessionStart: HookCallbackMatcher[]`, каждый элемент — `{hooks: HookCallback[]}`.
- `HookCallback = (input: HookInput, toolUseID, {signal}) => Promise<HookJSONOutput>`.
- Возврат: `{hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: string}}` — тот же механизм, что вставил блок «You have superpowers» в начало этой самой CLI-сессии.
- Наблюдаемо в потоке сообщений: `SDKHookResponseMessage {type:'system', subtype:'hook_response', hook_event:'SessionStart', output}` — можно проверить живым тестом без полного хода модели, просто поймав это сообщение и остановившись (по аналогии с тем, как уже проверялось `system/init` в предыдущей итерации).
- `source: 'startup'|'resume'|'clear'|'compact'|'fork'` в `SessionStartHookInput` — хук намеренно не фильтрует по `source`: сигнал должен всплывать одинаково при любом старте, включая клонов (`fork`) и после компакта.

## 4. Структура файлов

- **Новый `packages/mekiri-host/src/tuningSignal.ts`** — чистая функция `computeTuningSignalContext(entries: AuditEntry[]): string | undefined`. Без SDK-типов, без I/O — принимает уже прочитанный массив записей, легко unit-тестируется на синтетических данных без временных файлов и без query().
- **`packages/mekiri-host/src/permissions.ts`** — тонкая фабрика `createSessionStartHook(dir: string): HookCallback`, которая читает `audit.jsonl` (`readAuditLog` из `mekiri-core`) и передаёт результат в `computeTuningSignalContext`. `buildQueryOptions()` получает `hooks: {SessionStart: [{hooks: [createSessionStartHook(context.cwd)]}]}` — фабрика вызывается заново на каждый вызов `buildQueryOptions`, поэтому хук всегда читает лог актуального `context.cwd`, а не захватывает устаревшее значение.

Пороговые константы (2×, ≥3, ≥2) объявляются один раз в `tuningSignal.ts` с комментарием, что они обязаны совпадать с числами, зафиксированными прозой в скилле `mekiri-tuning` — полного DRY через границу код/markdown нет, но явная перекрёстная ссылка в комментарии — практическая мера против рассинхрона (тот же паттерн, что уже используется в комментарии над `MEKIRI_SYSTEM_PROMPT`).

## 5. Тестирование

- **Unit-тесты `computeTuningSignalContext`** на синтетических массивах `AuditEntry[]`: нет сигнала (мало записей или высокие метрики) → `undefined`; DR-сигнал (≥3 подряд `prune`, среднее <2×) → непустая строка с числами; BC-сигнал аналогично; сигнал подавлен, если после него есть `configure_mekiri`-запись (anti-nag).
- **Живой smoke-тест wiring:** реальная сессия с заранее подготовленным во временном каталоге «плохим» `audit.jsonl` (синтетические записи с низким DR), проверка, что среди сообщений потока реально встречается `hook_response` с `hook_event: 'SessionStart'` и `output`, содержащим ожидаемые цифры. Ловим сообщение и завершаем поток сразу — не платим за полный ход модели, аналогично тому, как уже проверялось обнаружение скиллов в предыдущей итерации.

## 6. Вне скоупа

- Pre-compact snapshot (tz.md §8) — по-прежнему не в скоупе: архитектурная нестыковка (`PreCompact`-хук стреляет не там, где нужно по §8) не разрешена этой итерацией; данная задача закрывает только инфраструктуру `hooks` как таковую и её первое реальное применение (tuning-сигнал), не касаясь `PreCompact` вообще.
- Автоматизация Trigger A и `depth_limit_exceeded`-сигнала — принципиально невозможна на старте сессии, см. §2.
- Калибровка реальных числовых порогов — по-прежнему плейсхолдеры (сознательно, как и в самом скилле `mekiri-tuning`).
