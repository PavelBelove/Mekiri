import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon } from "../src/daemonEnsure.js";
import { createToolHandlers, postControlRuleOverHttp } from "../src/mcpServer.js";

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
        "Срезать хвост текущей сессии от указанной цитаты до текущего момента, заменив его на дистиллят. " +
        "Вызывай сразу после КАЖДОГО закрытого микро-эпизода (прочитал файл ради одного вопроса, прогнал один тест-сьют, " +
        "получил один вердикт) -- не только в конце всей объявленной задачи и не дожидаясь накопления нескольких эпизодов.",
      inputSchema: {
        quote: z
          .string()
          .describe(
            "Дословная подстрока из УЖЕ ЗАВЕРШЁННОГО предыдущего хода (ответа ассистента), " +
              "с этого места начинается срез. НЕ может быть текстом из текущего, ещё не отправленного сообщения."
          ),
        note_type: z
          .enum(["portal", "death_reload"])
          .describe(
            "portal -- эпизод закрыт успешно, нужен только результат. death_reload -- тупик/неверная гипотеза, откат с уроком на будущее."
          ),
        fruit: z
          .record(z.string(), z.unknown())
          .describe(
            "Для portal: { summary: string (обязательно), files_touched?: {path, change}[], gotchas?: string }. " +
              "Для death_reload: { tried: string (обязательно), ruled_out: string (обязательно), facts_learned?: string, trigger?: string }."
          ),
        keep_code: z.boolean().describe("Сохранить ли фактические изменения кода/файлов, сделанные внутри вырезаемого диапазона (сам диапазон в контексте всё равно вырезается)."),
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
    "tag",
    {
      description:
        "Пометить цитатой диапазон контекста как важный для понимания -- без среза. В отличие от prune, ничего не " +
        "вырезает из ствола сессии: закладка в «бортовой журнал», а не откат. Вызывай, когда пройденный участок " +
        "содержит понимание, ценное для следующих поколений агентов в этом проекте (не только для тебя сейчас), " +
        "и его стоит уметь найти и вытащить через graft позже -- независимо от того, останется ли он в живом " +
        "контексте или будет позже срезан обычным prune.",
      inputSchema: {
        quote: z
          .string()
          .describe(
            "Дословная подстрока из УЖЕ ЗАВЕРШЁННОГО предыдущего хода, отмечающая конец помечаемого диапазона " +
              "(от начала сессии или последнего среза до этой цитаты включительно). НЕ может быть текстом из " +
              "текущего, ещё не отправленного сообщения."
          ),
        fruit: z
          .record(z.string(), z.unknown())
          .describe("{ summary: string (обязательно), files_touched: {path, change}[] (обязательно), gotchas?: string }."),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.tag(args)) }] })
  );

  server.registerTool(
    "graft",
    {
      description:
        "Прочитать обратно запись, сохранённую через prune или tag. Без target -- оглавление записей ТЕКУЩЕЙ сессии " +
        "(capsule.md этой сессии), дёшево независимо от возраста проекта. С target = rule_id -- полное тело конкретной " +
        "записи из любой сессии этого проекта, обёрнутое метаданными восстановления (событие, сессия, время). Это " +
        "чтение из собственного плоского архива на диске, а не из живой сессии -- переживает компактизацию по конструкции.",
      inputSchema: { target: z.string().optional().describe("rule_id записи из оглавления (capsule.md) любой сессии. Без него возвращается оглавление текущей сессии.") },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlers.graft(args)) }] })
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
