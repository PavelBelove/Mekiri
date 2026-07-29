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

  const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const daemonEntry = path.join(__dirname, "daemon.ts");
  await ensureDaemon({ port: PORT, spawnCommand: tsxBin, spawnArgs: [daemonEntry, String(PORT)] });

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
      description: "Срезать хвост текущей сессии от указанной цитаты до текущего момента, заменив его на дистиллят.",
      inputSchema: {
        quote: z.string(),
        note_type: z.enum(["portal", "death_reload"]),
        fruit: z.unknown(),
        keep_code: z.boolean(),
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

  // sprout is registered here too, once Task 11 lands -- see that task for the diff.

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("mekiri-proxy MCP server failed to start:", err);
  process.exit(1);
});
