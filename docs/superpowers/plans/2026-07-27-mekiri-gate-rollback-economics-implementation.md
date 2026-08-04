# mekiri-gate Rollback Economics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a timing/economics refinement to `mekiri-gate`'s existing prune reflex — the model should recognize when finishing the current subtask (≤~10 turns away, or a ≤2-generation fix) is cheaper than rolling back now, versus when a dead end with no end in sight means rolling back immediately is correct, both live-proven behaviorally.

**Architecture:** Single-file content change — `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md` gains a new "Экономика отката" section between the existing mantra and the four-question gate. No code changes. `MEKIRI_SYSTEM_PROMPT` is untouched (this detailed timing logic belongs at the skill layer, per the project's three-layer prompt architecture).

**Tech Stack:** Markdown (skill content), TypeScript/Vitest for the live behavioral proof test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-mekiri-gate-rollback-economics-design.md`.
- Only `mekiri-gate/SKILL.md` changes. `MEKIRI_SYSTEM_PROMPT` (`permissions.ts`) is not touched.
- The new section goes between the existing "Быстрый рефлекс" mantra line and the "## Три вопроса по порядку" heading — it must not remove or reword either.
- The exact numbers (≤~10 turns, ≤2 generations, ~20 actions/5-6 turns warm + ~5 min TTL) are the project owner's own empirical figures — use them verbatim, don't re-derive or round differently.

---

### Task 1: Add the rollback-economics section + live behavioral proof

**Files:**
- Modify: `packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md`
- Test: `packages/mekiri-host/test/repl.smoke.test.ts` (two new live smoke tests)

**Interfaces:**
- Consumes: `createMekiriTools`, `createAsyncSproutLimiter`, `createClaudeCodeBackend`, `createInputQueue`, `query`, `buildQueryOptions` — all already imported in `repl.smoke.test.ts` (same imports used by the existing "system prompt steers dispatch behavior" test in this file).
- Produces: nothing consumed by a later task — this is the only task in this plan.

- [ ] **Step 1: Add the new section to `mekiri-gate/SKILL.md`**

Read the current file first. Find:
```markdown
**Быстрый рефлекс**: испачкался — `prune`. Собираешься пачкаться подзадачей — `sprout`. Ниже — полный гейт для случаев, где это неочевидно (в частности, вопрос 1 может вообще запретить форк).

## Три вопроса по порядку (перед тем как начать)
```
Replace with:
```markdown
**Быстрый рефлекс**: испачкался — `prune`. Собираешься пачкаться подзадачей — `sprout`. Ниже — полный гейт для случаев, где это неочевидно (в частности, вопрос 1 может вообще запретить форк).

## Экономика отката (когда именно, не только «испачкался»)

Рефлекс «испачкался → prune» не значит «прямо в эту секунду». Перед откатом быстро прикинь:

- **Осталось ≤ ~10 ходов до завершения подзадачи, ИЛИ причина уже понятна и решение займёт ≤ 2 генерации** → не откатывайся сейчас. Доделай, закрой эпизод, и уже затем — `prune(portal)` постфактум (см. Вопрос 4 ниже). Откатываться, когда до финиша рукой подать, — терять тёплый кеш без нужды, суп доесть дешевле, чем мыть тарелку раньше времени.
- **Иначе (конца не видно, > ~10 ходов, или неопределённость)** → откатывайся сейчас, не жди.

Не затягивай дальше необходимого: тёплый кеш живёт ограниченное время (~20 последних действий, 5-6 ходов агента, затем ~5 минут TTL до полного остывания). После этого окна следующий запрос читается с нуля по полной цене — откатился ты или нет, значения уже не имеет. Ждать дальше этой границы не экономит ничего, только копит мусор без всякой компенсации.

## Три вопроса по порядку (перед тем как начать)
```

- [ ] **Step 2: Write the two live behavioral proof tests**

Read `packages/mekiri-host/test/repl.smoke.test.ts` in full first — find the existing `describe("mekiri-host live smoke test: system prompt steers dispatch behavior", ...)` block (narration-only pattern: gives the model a scenario, explicitly forbids calling any Mekiri tool, asks it to explain its choice in 1-2 sentences, checks the resulting text). Both new tests follow this exact pattern.

Add this new `describe` block at the end of the file:
```ts
describe("mekiri-host live smoke test: rollback economics steers timing, not just whether", () => {
  it("chooses to finish first and prune postfactum when the fix is within ~2 generations", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-rollback-econ-a-"));

    try {
      const tools = createMekiriTools({
        dir: projectDir,
        depth: 0,
        isClone: false,
        backend: createClaudeCodeBackend(),
        getSessionId: () => "unused-in-this-test",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("prune should not be called -- the task explicitly forbids calling any tool, only explaining the choice");
        },
        onHarvest: () => {
          throw new Error("harvest should not be called in this test");
        },
        asyncSproutLimiter: createAsyncSproutLimiter(),
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called in this test");
        },
      });

      const { iterable, push, close } = createInputQueue();
      push(
        [
          "Ты долго разбирался с багом, перепробовал несколько гипотез, но только что нашёл точную причину -- это буквально одна строка кода, её нужно поправить и дописать один тест, работы на пару ходов, конец уже виден.",
          "Прежде чем действовать, одним-двумя предложениями объясни, откатишься ли ты прямо сейчас (prune) или сначала доделаешь работу, и почему. Не выполняй саму работу и не вызывай prune/sprout/harvest/configure_mekiri -- просто объясни свой выбор и подожди подтверждения.",
        ].join("\n"),
      );
      close();

      const blocks: unknown[] = [];

      const q = query({
        prompt: iterable,
        options: buildQueryOptions({ resume: undefined, cwd: projectDir, mcpServers: { mekiri: tools } }),
      });
      for await (const message of q) {
        if (message.type === "assistant") {
          blocks.push(...message.message.content);
        }
      }

      const combined = JSON.stringify(blocks).toLowerCase();
      expect(combined).toContain("постфактум");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("chooses to roll back now when the dead end has no end in sight", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-rollback-econ-b-"));

    try {
      const tools = createMekiriTools({
        dir: projectDir,
        depth: 0,
        isClone: false,
        backend: createClaudeCodeBackend(),
        getSessionId: () => "unused-in-this-test",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("prune should not be called -- the task explicitly forbids calling any tool, only explaining the choice");
        },
        onHarvest: () => {
          throw new Error("harvest should not be called in this test");
        },
        asyncSproutLimiter: createAsyncSproutLimiter(),
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called in this test");
        },
      });

      const { iterable, push, close } = createInputQueue();
      push(
        [
          "Ты уже потратил много ходов на гипотезу про race condition, перепробовал три разных фикса, ни один не сработал, направление явно тупиковое, и непонятно, сколько ещё ходов потребуется, чтобы найти реальную причину.",
          "Прежде чем действовать, одним-двумя предложениями объясни, откатишься ли ты прямо сейчас (prune) или продолжишь пытаться, и почему. Не выполняй саму работу и не вызывай prune/sprout/harvest/configure_mekiri -- просто объясни свой выбор и подожди подтверждения.",
        ].join("\n"),
      );
      close();

      const blocks: unknown[] = [];

      const q = query({
        prompt: iterable,
        options: buildQueryOptions({ resume: undefined, cwd: projectDir, mcpServers: { mekiri: tools } }),
      });
      for await (const message of q) {
        if (message.type === "assistant") {
          blocks.push(...message.message.content);
        }
      }

      const combined = JSON.stringify(blocks).toLowerCase();
      expect(combined).toContain("prune");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});
```

- [ ] **Step 3: Run the two new tests**

Run: `npm run test --workspace=mekiri-host -- repl.smoke -t "rollback economics"`
Expected: PASS (2 tests). Both are real, billed live calls. If either fails, read the actual assistant text in the failure output before assuming it's a flaky test to retry — this is a real finding about whether the new skill wording actually steers the model's timing judgment. Per the plan's global constraints, the exact numbers (≤10 turns, ≤2 generations, cache window) are fixed and must not be reworded; if the test fails, you may adjust the test's own scenario-description wording (not the assertion, not the skill content) to more unambiguously match one case or the other, and must document any such adjustment and your reasoning in your report.

- [ ] **Step 4: Run the full mekiri-host suite**

Run: `npm run test --workspace=mekiri-host`
Expected: PASS, all files, no regressions (in particular, confirm the existing "system prompt steers dispatch behavior" test and the earlier "hard-gate reflex actually fires sprout" test from the previous feature still pass unmodified).

- [ ] **Step 5: Commit**

```bash
git add packages/mekiri-host/skills-plugin/skills/mekiri-gate/SKILL.md packages/mekiri-host/test/repl.smoke.test.ts
git commit -m "feat(mekiri-gate): add rollback-economics timing section, live-proven"
```

---

## After this plan

Not covered here (see spec §4): no change to `MEKIRI_SYSTEM_PROMPT` or `mekiri-tuning`; the exact numeric thresholds are the project owner's empirical estimates, not re-derived — if they later prove inaccurate in practice, that's a separate follow-up edit, not a defect of this one.
