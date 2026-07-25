# Дизайн: configure_mekiri для mekiri-host

**Проект:** Mekiri
**Статус:** спек, ожидает ревью пользователя
**Контекст:** [2026-07-24-core-primitive-design.md](2026-07-24-core-primitive-design.md) §5/§6 (исходная спецификация тулзы и конфиг-слоя), `packages/mekiri-core` (`loadConfig`/`saveConfig`/`applyConfigPatch`/`ConfigureAuditEntry` уже реализованы и одобрены)
**Скоуп:** одна тулза, разблокирующая скилл `mekiri-tuning` (следующая итерация). Никаких изменений в `mekiri-core` не требуется — все нужные примитивы уже экспортированы.

---

## 1. Зачем сейчас

Скилл `mekiri-tuning` по своей исходной спецификации обязан вызывать `configure_mekiri` при явном приоритете пользователя или при накоплении метрик с чётким сигналом. Без самой тулзы скилл был бы нефункциональным (мог бы только «предложить» правку файла руками). Эта итерация закрывает зависимость первой.

## 2. Хендлер

`handleConfigure(context: MekiriToolsContext, args: ConfigureArgs)` в `packages/mekiri-host/src/tools.ts`:

1. `loadConfig(context.dir)` — текущий конфиг (`mekiri-core`, уже возвращает дефолты, если файла нет).
2. `applyConfigPatch(current, args.patch)` (`mekiri-core`) — глубокий мердж + валидация целиком через `MekiriConfigSchema`.
3. `status: "invalid"` → `{content:[...], isError:true}` с текстом ошибок, **без** записи на диск и без audit-записи.
4. `status: "ok"` → `saveConfig(context.dir, result.config)`, затем `appendAuditEntry(context.dir, {event:"configure_mekiri", timestamp, reason: args.reason, patch: args.patch})` (тип `ConfigureAuditEntry` уже есть в `mekiri-core`).
5. Возврат `{status:"ok", config: result.config}` как tool_result.

**Доступность:** везде — и родителю, и клонам любой глубины, без проверки `isClone` (в отличие от `harvest`). Нет структурной причины запрещать клону подстраивать общий конфиг, если он видит в этом смысл по ходу задачи; `reason` в audit-логе всё равно фиксирует, кто и почему менял.

## 3. Схема тулзы

```ts
configure_mekiri({
  patch: Record<string, unknown>,  // частичный объект конфига, глубоко мерджится с текущим
  reason: string,                   // обязательное — идёт в audit-лог
})
→ { status: "ok", config: MekiriConfig }
  | { status: "invalid", errors: string[] }
```

`patch` валидируется как свободный объект на уровне Zod-схемы тулзы (`z.record(z.string(), z.unknown())`, тот же паттерн, что у `fruit` в `prune`) — реальная структурная валидация происходит внутри `applyConfigPatch` против `MekiriConfigSchema`, не дублируется на уровне тулзы.

## 4. Тестирование

Вся логика — локальные файловые операции, уже протестированные внутри `mekiri-core`. `handleConfigure` тестируется полностью без единого живого вызова (реальные временные `.mekiri/config.json`/`.mekiri/audit.jsonl` в `mkdtemp`-директории, тот же паттерн, что и у остальных обработчиков). Один минимальный живой smoke-тест — подтвердить, что реальная модель находит и вызывает тулзу под её именем (`mcp__mekiri__configure_mekiri`) через полный стек, тем же способом, что и для `prune`/`sprout`/`harvest`.

## 5. Вне скоупа

Скилл `mekiri-tuning` сам по себе — отдельная (следующая) итерация, использующая эту тулзу.
