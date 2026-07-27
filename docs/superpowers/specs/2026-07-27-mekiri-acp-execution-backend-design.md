# Mekiri: ACP-совместимый внутренний интерфейс (Фаза 2) — design

**Дата:** 2026-07-27
**Скоуп:** Фаза 2 миграции на ACP по tz.md §2/§10 и whitepaper.md §7 — привести внутренний интерфейс `mekiri-core` к терминам ACP (`sessionId`, `messageId`, семантика fork), ничего не переключая на реальный протокол. Explicitly НЕ Фаза 3 (реальный ACP-прокси/протокол) — та зависит от ещё не принятых RFD и остаётся отдельной, более рискованной задачей на будущее.

---

## 1. Зачем именно сейчас и что изменилось со времени вайтпейпера

whitepaper.md §7 фиксировал риск на момент написания: оба нужных RFD (`session/fork`, `Agent Extensions via ACP Proxies`) не приняты, прокси-стек (`sacp-conductor`) — ранний Rust-прототип. Проверка сегодня (2026-07-27, через `agentclientprotocol.com/rfds/*` и опубликованный TypeScript SDK):

- `session/fork` остаётся «предложением в разработке» (не formally accepted), но форма API устоялась: `ForkSessionRequest = {sessionId: SessionId, cwd: string, additionalDirectories?: string[], mcpServers?: McpServer[]}`. **messageId-параметра нет** — явно помечено «может быть добавлено в будущем», сейчас форк всегда от текущего конца истории сессии.
- `sacp-conductor` — уже опубликованный, версионированный (5.0.1) крейт на crates.io, не черновой прототип.

Отсутствие messageId в реальном RFD не блокирует наши примитивы: `sprout` форкает именно текущий накопленный контекст (ровно то, что даёт `session/fork` без messageId), а `prune` не форкает назад вообще — он начинает новую сессию с написанной заметкой, что по духу ближе к `session/new`, а не к forking истории. Так что не нужно проектировать вокруг ещё не существующей возможности.

## 2. Архитектура

Ввести границу между **логикой** (поиск точки среза по цитате, prune/sprout-семантика, метрики — всё уже чистые функции над `RawLine[]`) и **слоем исполнения** (сейчас единственный — Claude Code jsonl-файлы + Agent SDK's `forkSession`). Граница — новый интерфейс `ExecutionBackend` в `mekiri-core`, с единственной сегодняшней реализацией `ClaudeCodeBackend`. Ничего в `quoteMatcher.ts`/`compactZone.ts`/`metrics.ts`/`sessionTree.ts`/`metricsReport.ts` не меняется — они уже работают с данными (`RawLine[]`), а не с живыми вызовами; переносить их на абстрактную (не Claude-Code-специфичную) форму транскрипта — задача Фазы 3, когда появится второй реальный backend, против которого можно проверить абстракцию (YAGNI — не проектировать форму, которую нечем валидировать).

### 2.1. Переименование в `BoundaryResult`

`packages/mekiri-core/src/types.ts`, текущее:
```ts
export type BoundaryResult =
  | { status: "ok"; uuid: string }
  | { status: "not_found" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "in_compacted_zone"; lastCompactUuid: string };
```
становится:
```ts
export type BoundaryResult =
  | { status: "ok"; messageId: string }
  | { status: "not_found" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "in_compacted_zone"; lastCompactMessageId: string };
```
`messageId`/`lastCompactMessageId` — значение то же самое (Claude Code jsonl'ного `line.uuid`), только имя в публичном контракте теперь ACP-термин. Внутри `RawLine.uuid` (сырое поле формата Claude Code) не переименовывается — оно должно оставаться байт-в-байт как в реальном транскрипте (tz.md §2: «любое изменение префикса убивает кеш»).

Правки: `quoteMatcher.ts` (генерирует `BoundaryResult`), и два места использования в `packages/mekiri-host/src/tools.ts` (`boundary.uuid` → `boundary.messageId` в обоих местах, строки ~94 и ~105 на момент письма этой спеки).

### 2.2. `ExecutionBackend`

Только то, что реально использует `createBranch` (единственный сегодняшний потребитель) — не добавляем `readTranscript` в интерфейс: постфактумное чтение транскриптов (`metricsReport.ts` и остальные) — отдельная, уже работающая забота, не часть live fork-операции, и добавлять непотреблённый метод в интерфейс сейчас значило бы проектировать форму, которую нечем проверить (тот же принцип YAGNI, что и в п.4 «вне скоупа»).

Новый файл `packages/mekiri-core/src/executionBackend.ts`:
```ts
/**
 * ACP-shaped ids -- string aliases today (mirrors Claude Code's own uuid
 * strings), documented separately so the eventual real ACP SessionId/
 * MessageId types can replace them without touching call sites.
 */
export type SessionId = string;
export type MessageId = string;

export interface ForkOptions {
  dir: string;
  /** Present only for prune (fork up to a specific point); absent for sprout (fork the current end of history). */
  upToMessageId?: MessageId;
}

export interface ForkResult {
  newSessionId: SessionId;
}

/**
 * The execution-layer seam tz.md §2/§10 calls for: the one live operation
 * mekiri-core's prune/sprout logic needs from "wherever sessions actually
 * live" -- forking. Today's only implementation is ClaudeCodeBackend
 * (claudeCodeBackend.ts), wrapping the Agent SDK's forkSession. A future
 * ACP backend implements the same interface against a live proxy instead --
 * Phase 3, not built here.
 */
export interface ExecutionBackend {
  forkSession(sessionId: SessionId, options: ForkOptions): Promise<ForkResult>;
}
```

Форма `forkSession`/`ForkOptions` намеренно зеркалит проверенный сегодня реальный `ForkSessionRequest` (`sessionId`, `cwd`≈`dir`, опциональные расширения) — не изобретена, а сверена с текущим ACP TS SDK.

### 2.3. `ClaudeCodeBackend`

Новый файл `packages/mekiri-core/src/claudeCodeBackend.ts`:
```ts
import { forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionBackend, ForkOptions, ForkResult, SessionId } from "./executionBackend.js";

export function createClaudeCodeBackend(): ExecutionBackend {
  return {
    async forkSession(sessionId: SessionId, options: ForkOptions): Promise<ForkResult> {
      const result = await sdkForkSession(sessionId, { dir: options.dir, upToMessageId: options.upToMessageId });
      return { newSessionId: result.sessionId };
    },
  };
}
```
Существующая retry-обёртка вокруг форка (`createBranchWithRetry` в `mekiri-host/src/tools.ts`, [50,100,200,400]ms по известной гонке с диск-флашем SDK) остаётся на месте и не переносится в backend — это mekiri-host-специфичная политика повторов, а не часть контракта интерфейса.

### 2.4. `branch.ts`: `createBranch` берёт backend параметром

Текущее (`packages/mekiri-core/src/branch.ts`) напрямую импортирует и вызывает `forkSession` из SDK. Меняется на:
```ts
export type CreateBranchArgs =
  | (CreateBranchCommon & { branchType: "prune"; upToMessageId: string; noteType: NoteType })
  | (CreateBranchCommon & { branchType: "sprout" });

export async function createBranch(backend: ExecutionBackend, args: CreateBranchArgs): Promise<CreateBranchResult> {
  const result = await backend.forkSession(args.sessionId, {
    dir: args.dir,
    upToMessageId: args.branchType === "prune" ? args.upToMessageId : undefined,
  });
  // ...остальное (запись аудита) без изменений...
}
```
Только сигнатура и источник форка меняются; аудит-логика (`appendAuditEntry` вызовы для prune/sprout) не трогается.

### 2.5. `mekiri-host`: один инстанс backend'а, и второй прямой вызов SDK, который тоже нужно закрыть

Проверка кода нашла: `handleSprout` в `tools.ts` (строка ~200 на момент письма) вызывает SDK-шный `forkSession` **напрямую**, в обход `createBranch` — `createBranch`'ный `branchType: "sprout"` случай в `branch.ts` в продакшене вообще не используется, `handleSprout` форкает сам и сам же пишет `SproutAuditEntry`. Значит если рефакторить только `createBranch`, sprout — один из двух главных примитивов Mekiri — останется жёстко привязан к SDK, и цель Фазы 2 («внутренний интерфейс тулз... в терминах ACP») не будет достигнута для половины тулз. Это меняет объём раздела, не только `branch.ts`:

- `MekiriToolsContext` (`tools.ts`) получает новое поле `backend: ExecutionBackend`.
- `createBranchWithRetry`/`createBranch` (prune-путь) берут `backend` из контекста, как в п.2.4.
- `handleSprout`'ный прямой вызов `forkSession(context.getSessionId(), {dir: context.dir})` заменяется на `context.backend.forkSession(context.getSessionId(), {dir: context.dir})` — сам SDK-импорт (`forkSession` из `@anthropic-ai/claude-agent-sdk`) убирается из `tools.ts` целиком. Окружающая логика (async/sync ветвление, ручная запись `SproutAuditEntry`, `asyncSproutLimiter`) не трогается — это mekiri-host-специфичная политика, не предмет этой фазы.
- `repl.ts` создаёт единственный `createClaudeCodeBackend()` инстанс рядом с уже существующим `createAsyncSproutLimiter()` и передаёт его в `createMekiriTools({...backend, ...})`.
- Клоны получают тот же backend через уже существующий механизм проброса (`handleSprout`'ный `buildTools`, который сегодня прокидывает `asyncSproutLimiter`/`onAsyncSproutComplete` в контекст клона тем же паттерном `...dynamic` — `backend` добавляется туда же, одной строкой, без изменения структуры проброса).

Один инстанс на процесс (родитель и все клоны его переиспользуют), не пересоздаётся per-call — backend не хранит состояние сессии, так что это не влияет на поведение, просто экономит аллокации.

## 3. Тестирование — доказательство, а не формальность

Ключевой критерий готовности Фазы 2: логика реально не знает, что исполнение — Claude Code, а не что-то ещё. Доказывается без постройки второго настоящего backend'а (это Фаза 3):

- **`claudeCodeBackend.test.ts`** (новый) — сегодняшний `branch.test.ts`'ный живой прогон (реальный SDK `forkSession`, реальные файлы сессий на диске) переезжает сюда почти без изменений, теперь как тест конкретно `ClaudeCodeBackend`, а не `createBranch`.
- **`branch.test.ts`** (переработанный) — тестирует оркестрацию `createBranch` (правильный `ForkOptions` на вход в зависимости от prune/sprout, правильные аудит-записи на выход) против **фейкового in-memory `ExecutionBackend`** (простой объект с методом `forkSession`, возвращающий заранее заданное значение, без реального SDK, без файлов на диске). Это и есть тест, который физически не смог бы пройти, если бы `createBranch` продолжал знать о SDK напрямую.
- Остальные пакеты (`quoteMatcher.test.ts`, `metrics.test.ts` и т.д.) — не меняются по сути, только переименование `uuid`→`messageId`/`lastCompactUuid`→`lastCompactMessageId` там, где тесты явно проверяют эти поля `BoundaryResult`.
- `mekiri-host`'ные тесты, использующие `boundary.uuid` или напрямую вызывающие `createBranch`/`createBranchWithRetry`, обновляются под новую сигнатуру (передача backend'а) и новое имя поля.

## 4. Вне скоупа (явно, не на будущее «когда-нибудь забыли»)

- Реальный ACP backend / прокси / `sacp-conductor` — Фаза 3, отдельная задача, зависящая от состояния ещё не принятых RFD.
- Приведение самой формы `RawLine[]` (транскрипт) к backend-agnostic виду — сегодня это Claude Code jsonl-специфичный формат (`uuid`, `isSidechain`, `isCompactSummary`), и он таким и остаётся внутри `ClaudeCodeBackend`; абстрагировать его есть смысл только когда появится второй реальный backend с другой формой данных, иначе абстракция гадательная.
- `mekiri-host`'ная сторона (`repl.ts`/`clone.ts`'ные вызовы `query()` из Agent SDK) не трогается — это её собственный, отдельный, ещё более Claude-Code-специфичный слой (сама модель диалога), не предмет tz.md §2's «внутренний интерфейс тулз и зеркало транскрипта».
- Никаких новых тулз/полей в MCP-контракте `prune`/`sprout`/`harvest` — их внешний интерфейс для агента не меняется вообще, меняется только то, что происходит у mekiri-core под капотом.
