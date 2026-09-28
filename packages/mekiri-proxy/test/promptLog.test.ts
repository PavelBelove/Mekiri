import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Fixtures mirror shapes observed on the wire in this repo's own traffic
// (session a1ed4f55…, 2026-09-28); texts are shortened.
const reminder = (s: string) => ({ type: "text", text: `<system-reminder>\n${s}\n</system-reminder>` });
const ideOpened = {
  type: "text",
  text: "<ide_opened_file>The user opened the file /home/u/proj/src/a.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>",
};
const toolResult = { type: "tool_result", tool_use_id: "t1", content: "ok" };
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] };

describe("promptLog", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-prompts-test-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
    const { vi } = await import("vitest");
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("recognizePrompt", () => {
    it("keeps only the prompt of a first message, recording the opened file path", async () => {
      const { recognizePrompt } = await import("../src/promptLog.js");
      const r = recognizePrompt({
        role: "user",
        content: [reminder("CLAUDE.md…"), reminder("context"), ideOpened, { type: "text", text: "Каков статус?" }],
      });
      expect(r?.blocks.map((b) => b.text)).toEqual(["Каков статус?"]);
      expect(r?.ideOpenedFile).toBe("/home/u/proj/src/a.ts");
      expect(r?.interrupted).toBe(false);
    });

    it("rejects Stop-hook feedback, skill loads, compaction summaries, bare tool results and system messages", async () => {
      const { recognizePrompt } = await import("../src/promptLog.js");
      expect(recognizePrompt({ role: "user", content: "Stop hook feedback: [Mekiri] Ход завершён" })).toBeNull();
      expect(
        recognizePrompt({ role: "user", content: [toolResult, { type: "text", text: "Base directory for this skill: /x" }] }),
      ).toBeNull();
      expect(
        recognizePrompt({ role: "user", content: [reminder("x"), { type: "text", text: "This session is being continued from a previous conversation that ran out of context." }] }),
      ).toBeNull();
      expect(recognizePrompt({ role: "user", content: [toolResult] })).toBeNull();
      expect(recognizePrompt({ role: "system", content: [{ type: "text", text: "PostToolUse:Bash hook additional context: x" }] })).toBeNull();
    });

    it("recognizes an interrupt merged into a tool_result message", async () => {
      const { recognizePrompt } = await import("../src/promptLog.js");
      const r = recognizePrompt({
        role: "user",
        content: [toolResult, { type: "text", text: "[Request interrupted by user for tool use]" }, { type: "text", text: "Стоп, не так." }],
      });
      expect(r?.interrupted).toBe(true);
      expect(r?.blocks.map((b) => b.text)).toEqual(["Стоп, не так."]);
    });

    it("keeps an <ide_selection>-only prompt", async () => {
      const { recognizePrompt } = await import("../src/promptLog.js");
      const sel = { type: "text", text: "<ide_selection>The user selected lines 1-3:\nИМХО, часто мусор.</ide_selection>" };
      expect(recognizePrompt({ role: "user", content: [ideOpened, sel] })?.blocks).toEqual([sel]);
    });
  });

  describe("classifyPrompt", () => {
    it("tells prose, a pasted log and a code paste apart", async () => {
      const { classifyPrompt } = await import("../src/promptLog.js");
      const prose =
        "Давай решим вопрос компактизации радикально. Штатную отодвинем в настройках, она больше не нужна и остается только как страховка. " +
        "При приближении к порогу агент обнуляется полностью, сохраняя только последние несколько сообщений, но первым делом идет в капсулу последней сессии.";
      expect(classifyPrompt(prose).kind).toBe("speech");

      const log = Array.from({ length: 40 }, (_, i) =>
        `2026-09-28T12:${String(i).padStart(2, "0")}:01Z [INFO] daemon: POST /v1/messages 200 in ${100 + i}ms`,
      ).join("\n");
      const logResult = classifyPrompt(log);
      expect(logResult.kind).toBe("log");
      expect(logResult.gzipRatio).toBeGreaterThan(4);

      const code = [
        "export function f(a: number): number {",
        "  const b = a + 1;",
        "  if (b > 2) {",
        "    return b;",
        "  }",
        "  return a;",
        "}",
      ].join("\n");
      expect(classifyPrompt(code).kind).toBe("code");
    });
  });

  describe("logNewPrompts", () => {
    it("logs each prompt once across resends, with 0700/0600 permissions", async () => {
      const { logNewPrompts, readPromptIndex, promptsDir } = await import("../src/promptLog.js");
      const first = { role: "user", content: [reminder("x"), ideOpened, { type: "text", text: "Первый промпт" }] };
      await logNewPrompts("s", [first]);
      await logNewPrompts("s", [first, { role: "assistant", content: "ok" }]);
      await logNewPrompts("s", [first, { role: "assistant", content: "ok" }, { role: "user", content: "Stop hook feedback: prune" }]);
      await logNewPrompts("s", [
        first,
        { role: "assistant", content: "ok" },
        { role: "user", content: "Stop hook feedback: prune" },
        { role: "assistant", content: "done" },
        { role: "user", content: [{ type: "text", text: "Второй" }] },
      ]);
      const index = await readPromptIndex("s");
      expect(index.map((m) => [m.n, m.messageIndex])).toEqual([
        [1, 0],
        [2, 4],
      ]);
      expect(index[0].ideOpenedFile).toBe("/home/u/proj/src/a.ts");
      const dir = promptsDir("s");
      expect(readFileSync(path.join(dir, "001.md"), "utf8")).toBe("Первый промпт");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, "001.md")).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, "index.jsonl")).mode & 0o777).toBe(0o600);
    });

    it("logs only the new prompt when the last message is edited in place by an interrupt", async () => {
      const { logNewPrompts, readPromptIndex, readPrompt } = await import("../src/promptLog.js");
      const base = [{ role: "user", content: "Почини 7 багов" }, toolUse];
      await logNewPrompts("s", [...base, { role: "user", content: [toolResult] }]);
      const edited = [
        ...base,
        { role: "user", content: [toolResult, { type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "Не тот файл!" }] },
      ];
      await logNewPrompts("s", edited);
      await logNewPrompts("s", edited);
      const index = await readPromptIndex("s");
      expect(index).toHaveLength(2);
      expect(index[1].interrupted).toBe(true);
      expect((await readPrompt("s", 2))?.text).toBe("Не тот файл!");
    });

    it("collapses a prompt resent twice inside one message", async () => {
      const { logNewPrompts, readPrompt } = await import("../src/promptLog.js");
      const p = { type: "text", text: "Я бы не сравнивал даже с пруном." };
      await logNewPrompts("s", [{ role: "user", content: [p, { type: "text", text: "[Request interrupted by user] " }, p] }]);
      const loaded = await readPrompt("s", 1);
      expect(loaded?.text).toBe("Я бы не сравнивал даже с пруном.");
      expect(loaded?.meta.interrupted).toBe(true);
    });

    it("does not re-log a kept tail after a compaction shrink, but logs new prompts", async () => {
      const { logNewPrompts, readPromptIndex } = await import("../src/promptLog.js");
      const long = [
        { role: "user", content: "p1" },
        { role: "assistant", content: "a" },
        { role: "user", content: "p2" },
        { role: "assistant", content: "b" },
        { role: "user", content: "p3" },
      ];
      await logNewPrompts("s", long);
      await logNewPrompts("s", [
        { role: "user", content: "This session is being continued from a previous conversation. Summary…" },
        { role: "user", content: "p3" },
      ]);
      await logNewPrompts("s", [
        { role: "user", content: "This session is being continued from a previous conversation. Summary…" },
        { role: "user", content: "p3" },
        { role: "assistant", content: "c" },
        { role: "user", content: "p4" },
      ]);
      expect((await readPromptIndex("s")).map((m) => m.n)).toEqual([1, 2, 3, 4]);
    });

    it("does not duplicate after a daemon restart", async () => {
      const first = await import("../src/promptLog.js");
      const msgs = [{ role: "user", content: "p1" }, { role: "assistant", content: "a" }];
      await first.logNewPrompts("s", msgs);
      const { vi } = await import("vitest");
      vi.resetModules();
      const second = await import("../src/promptLog.js");
      await second.logNewPrompts("s", [...msgs, { role: "user", content: "p2" }]);
      expect((await second.readPromptIndex("s")).map((m) => m.messageIndex)).toEqual([0, 2]);
    });

    it("decodes image and PDF attachments to files", async () => {
      const { logNewPrompts, readPrompt } = await import("../src/promptLog.js");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const pdf = Buffer.from("%PDF-1.4 fake");
      await logNewPrompts("s", [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: "Смотри скрин" },
          ],
        },
      ]);
      const loaded = await readPrompt("s", 1);
      expect(loaded?.attachments.map((a) => [a.file, a.mediaType, a.bytes])).toEqual([
        ["001-1.png", "image/png", png.length],
        ["001-2.pdf", "application/pdf", pdf.length],
      ]);
      expect(readFileSync(loaded!.attachments[0].path)).toEqual(png);
    });

    it("backfills once from the shadow archive, mapping revision lines to their original index", async () => {
      const shadow = await import("../src/shadowTranscript.js");
      await shadow.appendNewShadowMessages("s", [{ role: "user", content: "p1" }, toolUse, { role: "user", content: [toolResult] }]);
      await shadow.appendNewShadowMessages("s", [
        { role: "user", content: "p1" },
        toolUse,
        { role: "user", content: [toolResult, { type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "p2" }] },
      ]);
      const { logNewPrompts, readPromptIndex } = await import("../src/promptLog.js");
      await logNewPrompts("s", [
        { role: "user", content: "p1" },
        toolUse,
        { role: "user", content: [toolResult, { type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "p2" }] },
      ]);
      const index = await readPromptIndex("s");
      expect(index.map((m) => [m.n, m.messageIndex, m.interrupted, m.backfilled ?? false])).toEqual([
        [1, 0, false, true],
        [2, 2, true, true],
      ]);
    });
  });
});
