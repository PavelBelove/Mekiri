# mekiri-gate / mekiri-tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two skills (`mekiri-gate`, `mekiri-tuning`) as a local SDK plugin bundled with `mekiri-host`, and wire that plugin into every `query()` call `mekiri-host` makes, so any agent it hosts — parent or clone — can actually discover and use them.

**Architecture:** A new `packages/mekiri-host/skills-plugin/` directory (`.claude-plugin/plugin.json` manifest + `skills/mekiri-gate/SKILL.md` + `skills/mekiri-tuning/SKILL.md`) is loaded via `Options.plugins` (`{type:'local', path}`). `buildQueryOptions()` in `permissions.ts` is the single choke point both `repl.ts` and `clone.ts` already call to build their `query()` options, so adding `plugins` there covers both call sites with one change. A live smoke test proves the real Agent SDK actually discovers both skills through the plugin (skill discovery is an SDK-internal filesystem walk, unreachable from a unit test).

**Tech Stack:** TypeScript/Node (ESM, `NodeNext"), `@anthropic-ai/claude-agent-sdk`, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-mekiri-gate-tuning-design.md`.
- Plugin path is resolved via `import.meta.dirname` inside `permissions.ts` (this file's own directory), **not** relative to the hosted project's `--dir` — the plugin must work regardless of which project `mekiri-host` is pointed at.
- No `.claude-plugin/marketplace.json` — the plugin is local-only, used exclusively by `mekiri-host`, never published.
- Skill content is written in Russian, matching `tz.md`/`core-primitive-design.md`, which the content is adapted from verbatim.
- `mekiri-gate` content = tz.md §7.1's three-question gate + Question 4 (postfactum `prune(portal)`) + its contrastive table, transcribed as-is — no new examples added (explicit decision during brainstorming).
- `mekiri-tuning` in scope: only Distillation Ratio and Branch Compression (the two metrics computable from a single `audit.jsonl` line each). Lifetime Token Savings / Virtual Context Lifetime / Context Recycling Ratio are explicitly out of scope (need session-file analysis, not available from `audit.jsonl` alone).
- `mekiri-tuning` placeholder thresholds (intentionally provisional, to be calibrated later): ≥3 consecutive `prune` entries averaging Distillation Ratio < 2×; ≥2 consecutive `sprout` entries averaging Branch Compression < 2×; any in-session `sprout` result of `{"status":"depth_limit_exceeded"}` (never appears in `audit.jsonl` — `handleSprout` returns before writing an audit entry, see `packages/mekiri-host/src/tools.ts:153-155`).
- Both skills must stay role-agnostic in their text — no "if you are a clone" branching. The clone-vs-parent behavior difference in `mekiri-tuning` is phrased as "act on whether you currently have contact with the user", not as role-conditional logic.
- `configure_mekiri`'s `reason` argument convention introduced by these skills: `"user_override: <what the user said>"` for Trigger A, `"metric_signal: <what the numbers showed>"` for Trigger B.

---

### Task 1: `skills-plugin` scaffold — manifest + both skills' content

**Files:**
- Create: `packages/mekiri-host/skills-plugin/.claude-plugin/plugin.json`
- Create: `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`
- Create: `packages/mekiri-host/skills-plugin/skills/mekiri-tuning/SKILL.md`
- Test: `packages/mekiri-host/test/skillsPlugin.test.ts`

**Interfaces:**
- Produces: a plugin directory at `packages/mekiri-host/skills-plugin/` with a valid `.claude-plugin/plugin.json` (`name`, `description`, `version` fields) and two skills discoverable by name (`mekiri-gate`, `mekiri-tuning`) — this is the exact directory Task 2's `SKILLS_PLUGIN_PATH` constant must point at.

- [ ] **Step 1: Write the failing test**

Create `packages/mekiri-host/test/skillsPlugin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_ROOT = path.join(import.meta.dirname, "..", "skills-plugin");

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("no frontmatter block found");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    fields[key] = value;
  }
  return fields;
}

describe("skills-plugin manifest", () => {
  it("plugin.json has the required fields", async () => {
    const raw = await readFile(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.name).toBe("mekiri");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.each(["mekiri-gate", "mekiri-tuning"])("skills-plugin skill: %s", (skillName) => {
  it("SKILL.md frontmatter has a matching name and non-empty description", async () => {
    const raw = await readFile(path.join(PLUGIN_ROOT, "skills", skillName, "SKILL.md"), "utf8");
    const fields = parseFrontmatter(raw);
    expect(fields.name).toBe(skillName);
    expect(fields.description.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=mekiri-host -- skillsPlugin`
Expected: FAIL — `ENOENT` reading `plugin.json` (directory doesn't exist yet).

- [ ] **Step 3: Create the plugin manifest**

Create `packages/mekiri-host/skills-plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "mekiri",
  "description": "Mekiri-specific skills (mekiri-gate, mekiri-tuning) for agents running inside mekiri-host",
  "version": "0.1.0"
}
```

- [ ] **Step 4: Write `mekiri-gate/SKILL.md`**

Create `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`:

```markdown
---
name: mekiri-gate
description: "Use before choosing how to dispatch work inside a mekiri-host session -- prune vs sprout vs a clean Task subagent vs staying inline. Applies identically to the parent session and to any sprout clone."
---

# mekiri-gate

Гейт выбора инструмента диспетчеризации внутри mekiri-host: `prune` / `sprout` / чистый субагент (Task) / инлайн-работа. Применяется одинаково и родительской сессией, и любым sprout-клоном.

## Три вопроса по порядку (перед тем как начать)

**Вопрос 1: задача вообще диспетчеризуема?**
Если по ходу решения потребуется вмешательство пользователя, коррекция курса, или задачу нельзя сформулировать одним заходом — ни клон, ни чистый субагент не годятся, независимо от актив/балласт. Смысл форка — изоляция плюс единственный отчёт на выходе; это несовместимо с необходимостью держать руку на пульте. Такая работа — инлайн, в главном потоке.

**Вопрос 2 (если да): унаследованный контекст сейчас — актив или балласт?**
- Актив, нужен не процесс, а результат → тёплый клон (`sprout`).
- Балласт или источник предубеждений → чистый субагент (Task tool), без наследования текущего контекста.

**Вопрос 3 (для клона, по ходу работы): контекст остаётся активом?**
Если внутри инстанса всплывают признаки застревания (те же тупики, что и триггер `death_reload`) — у клона есть право на самоэскалацию:
- вызвать внутри себя чистого субагента на узкий вопрос;
- вернуть родителю не результат, а рекомендацию через `harvest(result, needs_clean_look: true)` вместо отчёта об успехе.

Оба варианта дешевле, чем родитель узнаёт об этом только по факту провала клона.

**Вопрос 4 (для инлайн-работы, по завершении): побочный эпизод закрыт?**
Ответ «нет» на вопрос 1 не значит, что грязь остаётся навсегда — значит только, что клон/субагент не годились *в начале*. Если по ходу инлайн-работы стало ясно, что её кусок был на самом деле побочным эпизодом (починка бага внутри работы над фичей, а не сама фича), и этот эпизод завершён с результатом — закрыть его тем же `prune(portal)` постфактум, даже если реального выбора «клон или инлайн» в начале не было.

## Контрастные примеры

| Ситуация | Инструмент |
|---|---|
| «Прочитал 1000 строк логов, причина найдена, логи больше не нужны» | `prune(portal)` |
| «Гипотеза про сериализацию не подтвердилась, три захода впустую» | `prune(death_reload)` |
| «Нет, ты всё понял не так, ты сломал X» — фидбек пользователя в живой сессии | `prune(death_reload, trigger: user_feedback)`, а не попытка залатать поверх испорченного понимания |
| «Разберись с этим багом, пока я продолжаю фичу» — нужно всё текущее понимание | `sprout` |
| «Сходи в доки, найди формат вызова этого API» — опыт родителя не нужен | чистый субагент |
| Клон часами уверен в неверной гипотезе | самоэскалация клона (Вопрос 3) или изначально чистый субагент |
| «Почини, но я хочу видеть каждый шаг и решать, куда дальше» | ни то ни другое — инлайн |
| Чинил баг инлайн (нельзя было предвидеть заранее), баг починен, задача была явно не главной | `prune(portal)` постфактум — ретроактивная компрессия побочного эпизода (Вопрос 4) |
```

- [ ] **Step 5: Write `mekiri-tuning/SKILL.md`**

Create `packages/mekiri-host/skills-plugin/skills/mekiri-tuning/SKILL.md`:

```markdown
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test --workspace=mekiri-host -- skillsPlugin`
Expected: PASS (3 tests: manifest + 2 skills).

- [ ] **Step 7: Commit**

```bash
git add packages/mekiri-host/skills-plugin packages/mekiri-host/test/skillsPlugin.test.ts
git commit -m "feat(mekiri-host): add mekiri-gate/mekiri-tuning skills-plugin content"
```

---

### Task 2: Wire the skills-plugin into `buildQueryOptions`

**Files:**
- Modify: `packages/mekiri-host/src/permissions.ts`
- Test: `packages/mekiri-host/test/repl.smoke.test.ts` (extend the existing `describe("buildQueryOptions", ...)` block)

**Interfaces:**
- Consumes: the `packages/mekiri-host/skills-plugin/` directory produced by Task 1 (path only — this task does not read its contents, just references its location).
- Produces: `buildQueryOptions(...)` now returns an `Options` object whose `plugins` array includes `{type:"local", path: <absolute path to skills-plugin>}`. Both `repl.ts` and `clone.ts` already call `buildQueryOptions` for every `query()` call, so no changes are needed in either file — this is the single choke point.

- [ ] **Step 1: Write the failing test**

In `packages/mekiri-host/test/repl.smoke.test.ts`, extend the existing `describe("buildQueryOptions", ...)` block (around line 157) by adding a sibling `it`:

```ts
  it("wires the mekiri skills-plugin into the options object", () => {
    const options = buildQueryOptions({
      resume: undefined,
      cwd: "/tmp/does-not-matter",
      mcpServers: { mekiri: {} as never },
    });
    expect(options.plugins).toEqual([{ type: "local", path: expect.stringContaining("skills-plugin") }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=mekiri-host -- repl.smoke -t "wires the mekiri skills-plugin"`
Expected: FAIL — `options.plugins` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/mekiri-host/src/permissions.ts`, add near the top (after the existing imports):

```ts
import path from "node:path";
```

Add this constant right before `export const canUseTool`:

```ts
// mekiri-gate/mekiri-tuning ship as a local SDK plugin bundled with
// mekiri-host itself, not with whatever project is being hosted (--dir) --
// they must be available regardless of which project mekiri-host points at.
// import.meta.dirname is this file's own directory (src/ in dev, dist/ after
// build); skills-plugin/ sits one level up from either.
const SKILLS_PLUGIN_PATH = path.join(import.meta.dirname, "..", "skills-plugin");
```

Then modify the `buildQueryOptions` return object (currently `permissions.ts:65-71`):

```ts
export function buildQueryOptions(context: {
  resume: string | undefined;
  cwd: string;
  mcpServers: Options["mcpServers"];
}): Options {
  return {
    resume: context.resume,
    cwd: context.cwd,
    mcpServers: context.mcpServers,
    canUseTool,
    plugins: [{ type: "local", path: SKILLS_PLUGIN_PATH }],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=mekiri-host -- repl.smoke -t "wires the mekiri skills-plugin"`
Expected: PASS.

- [ ] **Step 5: Run the full mekiri-host unit test suite to confirm no regressions**

Run: `npm run test --workspace=mekiri-host`
Expected: PASS (all prior tests, including live smoke tests, still pass — this run makes real billed API calls, same as it always has).

- [ ] **Step 6: Commit**

```bash
git add packages/mekiri-host/src/permissions.ts packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "feat(mekiri-host): wire the mekiri skills-plugin into buildQueryOptions"
```

---

### Task 3: Live smoke test — real skill discovery end-to-end

**Files:**
- Test: `packages/mekiri-host/test/repl.smoke.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `buildQueryOptions` from Task 2 (already imported in this file), `createInputQueue` from `../src/inputQueue.js` (already imported in this file).
- Produces: nothing consumed by later tasks — this is the final proof step for this plan.

This is a smoke test proving already-implemented behavior end-to-end (mirrors this codebase's own convention: `configure_mekiri`'s wiring smoke test was added in a separate commit *after* the feature commit, see `77bb406` after `7fee9a3`) — there is no red/green cycle here, just write-run-confirm.

- [ ] **Step 1: Write the live smoke test**

Append to `packages/mekiri-host/test/repl.smoke.test.ts`:

```ts
// Real, billed proof that the SDK's own skill discovery actually finds
// mekiri-gate/mekiri-tuning through the bundled local plugin -- this is an
// SDK-internal filesystem walk (SDKSystemMessage.skills), not something a
// unit test can fake. Breaks immediately after the init message; no need to
// pay for a full turn since only skill discovery is under test here.
describe("mekiri-host live smoke test: mekiri-gate/mekiri-tuning skill discovery", () => {
  it("the real SDK discovers both mekiri skills through the bundled local plugin", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let discoveredSkills: string[] | undefined;

    const q = query({
      prompt: iterable,
      options: buildQueryOptions({ resume: undefined, cwd: process.cwd(), mcpServers: {} }),
    });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        discoveredSkills = message.skills;
        await q.return(undefined);
        break;
      }
    }

    expect(discoveredSkills).toContain("mekiri-gate");
    expect(discoveredSkills).toContain("mekiri-tuning");
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

Run: `npm run test --workspace=mekiri-host -- repl.smoke -t "skill discovery"`
Expected: PASS — `discoveredSkills` contains both `"mekiri-gate"` and `"mekiri-tuning"`.

If it fails with the skills missing, check (in order): `packages/mekiri-host/skills-plugin/.claude-plugin/plugin.json` exists and is valid JSON (Task 1); `SKILLS_PLUGIN_PATH` in `permissions.ts` actually resolves to that directory at runtime (log it or `console.error(SKILLS_PLUGIN_PATH)` temporarily) — the most likely failure mode is `import.meta.dirname` resolving to `dist/` in a build that hasn't happened yet, in which case run via `tsx` (as `npm test` already does) so it resolves to `src/`, one level below which `skills-plugin/` also sits.

- [ ] **Step 3: Commit**

```bash
git add packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "test(mekiri-host): add live smoke test for mekiri-gate/mekiri-tuning skill discovery"
```

---

## After this plan

Not covered here (see spec §5 "Вне скоупа"): the `mekiri-host` system-prompt gap, the three metrics formulas requiring session-file analysis, and real dogfooding of both skills' *content* (as opposed to their wiring) — the next step per project standing workflow (`[[feedback-dogfood-asap]]`) is to actually use `mekiri-gate` for a real dispatch decision and `mekiri-tuning`'s Trigger B against this repo's own accumulated `.mekiri/audit.jsonl`.
