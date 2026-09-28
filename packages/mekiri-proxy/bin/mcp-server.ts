import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon } from "../src/daemonEnsure.js";
import { createToolHandlers, postControlRuleOverHttp, registerSessionOverHttp } from "../src/mcpServer.js";

const PORT = Number(process.env.MEKIRI_PROXY_PORT ?? 8791);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    throw new Error("CLAUDE_CODE_SESSION_ID is not set -- mekiri-proxy's MCP server must be run by Claude Code, not standalone");
  }
  const depth = Number(process.env.MEKIRI_SPROUT_DEPTH ?? 0);

  const daemonEntry = path.join(__dirname, "daemon.ts");
  await ensureDaemon({ port: PORT, spawnCommand: "npx", spawnArgs: ["tsx", daemonEntry, String(PORT)] });
  // Best effort: an older daemon without /control/session just answers 404.
  await registerSessionOverHttp(PORT, sessionId, process.cwd()).catch(() => {});

  const handlers = createToolHandlers({
    sessionId,
    dir: process.cwd(),
    depth,
    daemonPort: PORT,
    postControlRule: postControlRuleOverHttp(PORT),
  });

  const server = new McpServer({ name: "mekiri-proxy", version: "0.1.0" });

  server.registerTool(
    "prune",
    {
      description:
        "Срезать хвост текущей сессии от указанной цитаты до текущего момента, заменив его на дистиллят, " +
        "и одновременно заархивировать важный контекст, который остаётся жить в сессии. " +
        "Вызывай сразу после КАЖДОГО закрытого микро-эпизода (прочитал файл ради одного вопроса, прогнал один тест-сьют, " +
        "получил один вердикт) -- не только в конце всей объявленной задачи и не дожидаясь накопления нескольких эпизодов.",
      inputSchema: {
        quote: z
          .string()
          .describe(
            "Дословная подстрока из хода, который УЖЕ ЗАКОНЧИЛСЯ И ВЕРНУЛ УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЮ -- проверяемая граница: " +
              "если ты прямо сейчас находишься внутри цепочки вызовов текущего хода (этот текст ещё не мог дойти до " +
              "пользователя), цитата из него НЕ валидна, даже если кажется, что \"этот текст только что был сказан\" -- " +
              "он физически ещё не записан в транскрипт. Если есть сомнение, считай, что это ещё не на диске. " +
              "Пустая строка означает \"резать нечего\" -- вызов только архивирует fruit.kept_context, ничего не удаляя из " +
              "контекста; это ПОЛНОЦЕННЫЙ, честный вызов (не заглушка), используй его вместо того чтобы гадать/изобретать цитату."
          ),
        note_type: z
          .enum(["portal", "death_reload"])
          .describe(
            "portal -- эпизод закрыт успешно, нужен только результат. death_reload -- тупик/неверная гипотеза, откат с уроком на будущее. " +
              "death_reload требует непустой quote (тупик всегда что-то режет)."
          ),
        fruit: z
          .record(z.string(), z.unknown())
          .describe(
            "kept_context: string (обязательно всегда, может быть пустой строкой) -- важный контекст, который остаётся жить в сессии, " +
              "но стоит заархивировать на будущее; если quote пустой, kept_context не может быть пустым одновременно. " +
              "conclusion: string (обязательно всегда, не может быть пустым) -- короткий (~8-12 слов) вывод/итог этой записи, " +
              "который станет строкой в capsule.md. Сформулирован как ВЫВОД/РЕЗУЛЬТАТ, а не как описание действия. Пиши его " +
              "ПОСЛЕДНИМ полем, когда остальной fruit уже составлен -- к этому моменту итог записи уже известен, и вывод " +
              "получится содержательным, а не обрезком первой фразы summary. " +
              "Для portal: { summary: string (обязательно, может быть пустым при пустом quote), files_touched?: {path, change}[], gotchas?: string }. " +
              "Для death_reload: { tried: string (обязательно), ruled_out: string (обязательно), facts_learned?: string, trigger?: string }."
          ),
        keep_code: z.boolean().describe("Сохранить ли фактические изменения кода/файлов, сделанные внутри вырезаемого диапазона (сам диапазон в контексте всё равно вырезается). Не используется, если quote пустой."),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.prune(args)) }] })
  );

  server.registerTool(
    "configure_mekiri",
    {
      description: "Патчит рантайм-конфиг Mekiri для текущей ветки (.mekiri/config.json).",
      inputSchema: { patch: z.record(z.string(), z.unknown()), reason: z.string() },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.configure_mekiri(args as any)) }] })
  );

  server.registerTool(
    "sprout",
    {
      description: "Форкнуть тёплого клона текущей сессии на изолированную подзадачу, унаследовав весь текущий контекст.",
      inputSchema: { task: z.string(), wait_mode: z.enum(["sync", "async"]).optional() },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.sprout(args)) }] })
  );

  server.registerTool(
    "graft",
    {
      description:
        "Прочитать обратно СЫРОЙ (raw) фрагмент контекста, вырезанный/помеченный через prune -- не дистиллят. Без " +
        "target -- оглавление записей ТЕКУЩЕЙ сессии (capsule.md этой сессии), дёшево независимо от возраста проекта. " +
        "С target = rule_id -- дословный фрагмент исходного транскрипта той сессии (не пересказ), обёрнутый " +
        "метаданными восстановления (событие, сессия, время); может быть урезан по размеру (см. truncated в ответе). " +
        "Дистиллят того же rule_id уже лежит в report.md той сессии и доступен обычным чтением файла. Это чтение из " +
        "собственного плоского архива на диске, а не из живой сессии -- переживает компактизацию по конструкции. " +
        "target = user#7 / user#7-10 / <sessionId>:user#7-10 -- дословные промпты пользователя (строки [user #N] " +
        "в капсуле), с вложениями-картинками.",
      inputSchema: { target: z.string().optional().describe("rule_id записи из оглавления (capsule.md) любой сессии, либо user#N / user#N-M / <sessionId>:user#N-M. Без него возвращается оглавление текущей сессии.") },
    },
    async (args) => {
      const result = await handlers.graft(args);
      // Prompt attachments: images go out as MCP image blocks (the agent sees
      // them without a Read outside the project), not as base64 in the JSON.
      if (result.status === "ok" && result.mode === "prompts" && result.images) {
        const { images, ...rest } = result;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(rest) },
            ...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mediaType })),
          ],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "metrics",
    {
      description:
        "Показать метрики эффективности Mekiri: сколько раз prune/sprout вызывались, во сколько раз дистиллят короче " +
        "вырезанного текста (distillationRatio), сжатие тёплого форка (branchCompression), доля произведённого " +
        "контекста, вернувшаяся дистиллятом в ствол (contextRecyclingRatio). Без scope или scope='session' -- дерево " +
        "текущей сессии. scope='project' -- все деревья сессий этого проекта разом.",
      inputSchema: { scope: z.enum(["session", "project"]).optional().describe("session (по умолчанию) -- метрики только текущей сессии. project -- по всем сессиям проекта.") },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.metrics(args)) }] })
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("mekiri-proxy MCP server failed to start:", err);
  process.exit(1);
});
