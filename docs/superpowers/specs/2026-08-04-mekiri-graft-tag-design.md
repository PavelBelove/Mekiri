# Дизайн: `tag`/`graft` + минимальный субстрат §6 (report/capsule)

**Проект:** Mekiri
**Статус:** спек, обсуждён и одобрен пользователем
**Контекст:** [Mekiri-memory.md](../../../Mekiri-memory.md) §4 (graft), §6 (библиотека), `packages/mekiri-proxy` (текущий реальный ствол — wire-level HTTP rewrite, `mekiri-host` заархивирован в `archive/mekiri-host`)
**Скоуп:** новый модуль `packages/mekiri-core/src/reportStore.ts`, новые MCP-тулзы `tag`/`graft` в `packages/mekiri-proxy/src/mcpServer.ts`, расширение `auditLog.ts`/`types.ts`.
**Вне скоупа:** отдельный `index.md` (проект-в-проекте пока один "ствол", масштаб не требует), мутируемость капсулы (устаревание записей), `допрос` (§8), `promote`.

---

## 0. Почему не адресация по live-сессии

`Mekiri-memory.md` §4 описывает `graft` как возврат ветки по `sessionId`/`message-uuid` живой сессии. Реальный ствол — эта самая VSCode/Claude Code сессия через `mekiri-proxy` — периодически проходит нативную компактизацию Claude Code; `.mekiri/audit.jsonl` уже показывает несколько разных `sessionId` для одной непрерывной работы, что согласуется с этим. Адресация по live-uuid работает до первой компактизации и затем молча ломается — риск, которого сам документ не называет, хотя открытая проблема `in_compacted_zone` уже зафиксирована в предыдущей сессии.

Решение: `graft` не трогает live-сессию вообще. Он читает из собственного плоского append-only хранилища на диске (`report.md`/`capsule.md`/`capsule-index.jsonl`), которое компактизацию переживает по конструкции — то есть §6 строится раньше и graft адресуется в него, а не в транскрипт.

---

## 1. Файлы на диске (`.mekiri/`)

**Правка (после первого догфудинга):** `report.md`/`capsule.md` изначально были одним общим файлом на весь проект — все сессии, когда-либо коснувшиеся проекта, писали в один и тот же `capsule.md`. Это ломает базовое допущение §10 "дёшево при масштабе ≤200 записей": по мере накопления сессий за месяцы работы toc-вид перестаёт быть дешёвым и релевантным. Исправлено на per-session раскладку ниже; `capsule-index.jsonl` остаётся общим на проект, поскольку уже хранит `sessionId` на каждую запись — это и есть индекс, который ссылается на per-session файлы.

**Известное ограничение, не решается в этом заходе:** `sessionId` не переживает нативную компактизацию Claude Code — один непрерывный человеческий рабочий заход может физически распасться на несколько разных `sessionId` (и, соответственно, несколько session-директорий). Стабильного "trunk"-идентификатора, переживающего компактизацию, в кодовой базе сейчас нет (`sessionTree.ts`/`buildSessionForest` строят генеалогию только по `prune`/`sprout`-событиям из `audit.jsonl`, не по компактизации). Решение отложено — потребует либо парсинга `compactMetadata` в транскрипте на предмет ссылки на родительскую сессию, либо минтинга собственного стабильного id, что за рамки этой правки.

- **`sessions/<sessionId>/report.md`** — append-only хроника одной сессии. Каждая запись: строка метаданных (`event`, `sessionId`, `ruleId`, `noteType`, ISO timestamp) + тело — тот же `renderDistillate()`, что уже использует `prune`.
- **`sessions/<sessionId>/capsule.md`** — человекочитаемый toc одной сессии, одна строка на запись: `«{header}» {startLine}-{endLine} — {event} {ruleId}`. `header` — первые ~80 символов `fruit.summary` (portal) или `fruit.tried` (death_reload); отдельного обязательного поля не заводится.
- **`capsule-index.jsonl`** (в корне `.mekiri/`, НЕ per-session) — по одному JSON-объекту на запись (`ruleId, header, startLine, endLine, event, sessionId, timestamp`) — машиночитаемый, общепроектный индекс для точного поиска `graft`'ом по `ruleId` из любой сессии. Поле `sessionId` в каждой записи говорит, в каком `sessions/<sessionId>/report.md` искать тело.

## 2. `packages/mekiri-core/src/reportStore.ts` (новый)

```ts
export interface ReportEntryMeta {
  event: "prune" | "tag";
  sessionId: string;
  ruleId: string;
  noteType: NoteType;
  timestamp: string;
}
export async function recordDistillate(
  dir: string, meta: ReportEntryMeta, header: string, bodyText: string
): Promise<{ startLine: number; endLine: number }>
export async function readReportRange(dir: string, sessionId: string, startLine: number, endLine: number): Promise<string>
export async function readCapsule(dir: string, sessionId: string): Promise<string>
export async function findCapsuleEntry(dir: string, ruleId: string): Promise<CapsuleIndexEntry | undefined>
```

`recordDistillate` меряет реальный диапазон строк (текущее число строк в `sessions/{meta.sessionId}/report.md` → append → diff, без отдельного персистентного счётчика — меньше риска рассинхрона), затем пишет парную строку в `sessions/{meta.sessionId}/capsule.md` и объект в общепроектный `capsule-index.jsonl`. Параллельные писатели реальны при `sprout.parallelism.count > 1` — все три записи сериализуются простым promise-chain мьютексом, keyed по `dir` (не по `dir`+`sessionId`: `capsule-index.jsonl` общий на проект, конкурентные писатели из разных сессий всё равно должны сериализоваться на нём). Экспортируется из `mekiri-core/src/index.ts`. `readCapsule`/`readReportRange` требуют явный `sessionId` — вызывающая сторона сама решает, чью сессию читает (обычно текущую, но для `readReportRange` это `sessionId` из найденной `CapsuleIndexEntry`, который может принадлежать другой сессии).

`CapsuleIndexEntry` — новый тип в `types.ts`.

## 3. `auditLog.ts` (расширение)

- `TagAuditEntry { event: "tag"; timestamp; sessionId; ruleId; markedLength; fruitLength }` — **правка после ревью пользователя**: изначальный вариант без `quote`/`markedLength` был отвергнут (см. §4 ниже) — `markedLength` меряет диапазон от начала сессии/последнего среза до цитаты включительно, тем же способом, что `removedBranchLength` у prune меряет хвост после неё. Само поле `removedBranchLength` тэгу по-прежнему не нужно — ничего не режется.
- `GraftAuditEntry { event: "graft"; timestamp; sessionId; targetRuleId?: string; mode: "toc" | "full" }` — задел под будущую метрику §10 ("доля plod'ов, потребовавших графта-восстановления").

## 4. Тулзы (`packages/mekiri-proxy/src/mcpServer.ts`)

### `tag`

**Правка (после ревью пользователя, отменяет исходное "без quote" решение ниже по логике этой же секции):** снимок без привязки к конкретному месту в транскрипте — это просто заметка, а не закладка в «бортовом журнале» для будущих поколений агентов. `tag` обязан принимать `quote`, как `prune`, и той же функцией `findBoundary` подтверждать, что цитата реально и однозначно существует в транскрипте — но, в отличие от `prune`, ничего не режет: `postControlRule`/`rewriteMessages` не вызываются вообще, размеченный диапазон остаётся жить в контексте как есть. `quote` здесь — это якорь и граница измерения (`markedLength`, §3), а не точка среза.

```ts
tag({ quote: string, fruit: unknown })
→ { status: "ok", rule_id: string }
  | { status: "ambiguous", occurrences: number }
  | { status: "not_found" }
  | { status: "in_compacted_zone", last_compact_message_id: string }
  | { status: "invalid_fruit", errors: string[] }
```

Валидация переиспользует `validateFruit({ noteType: "portal", fruit, keepCode: true })` — только portal-форма (снимок это не откат), `keepCode: true` вынуждает `files_touched` (снимок должен указывать на конкретное). Статусы боундари идентичны `prune` (переиспользуют тот же `findBoundary`), только не приводят ни к какому вызову `postControlRule`. Пишет через `recordDistillate` + `appendAuditEntry`.

### `graft`

```ts
graft({ target?: string })
→ { status: "ok", mode: "toc", content: string }   // без target — capsule.md ТЕКУЩЕЙ сессии
  | { status: "ok", mode: "full", content: string }  // target = ruleId — тело из report.md сессии-владельца записи, с обёрткой метаданных
  | { status: "not_found" }
```

Чистое чтение — MCP `tool_result` уже доставляет ответ "одним ходом, в обёртке инструмента" (§4), новой инфраструктуры доставки не требуется. Прогрессивное раскрытие: без `target` — оглавление текущей сессии (`readCapsule(dir, context.sessionId)`, дёшево независимо от возраста проекта — это и есть исправление, описанное в §1); с `target` — конкретное тело из `sessions/{entry.sessionId}/report.md` (не обязательно текущей сессии — `graft` по `target` работает кросс-сессионно через общий `capsule-index.jsonl`), обёрнутое `[graft: {event} {ruleId}, session {sessionId}, {timestamp}]`.

### `prune` (правка существующего)

После вычисления `distillateText` — один вызов `recordDistillate(..., event: "prune", ...)`, аналогично `tag`. Единственное изменение в существующей логике.

---

## 5. Тесты

- `mekiri-core/test/reportStore.test.ts`: диапазоны строк, конкурентные записи без пересечения диапазонов, round-trip `findCapsuleEntry`.
- `mekiri-proxy/test/mcpServer.test.ts`: `tag` (ok/invalid), `graft` (toc/full/not_found), `prune` теперь тоже пишет в report (графтуем результат prune и проверяем содержимое).

## 6. Дальнейшая дистрибуция

Implementer/reviewer через обычные Task-субагенты (не `mekiri-host`/`sprout` — тот архивирован и для строительства самого Mekiri больше не канал).
