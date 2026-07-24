import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateFruit, findBoundary, createBranch } from "mekiri-core";
import type { RawLine, NoteType } from "mekiri-core";

export interface MekiriToolsContext {
  dir: string;
  getSessionId: () => string;
  getTranscript: () => RawLine[];
  onSwitch: (newSessionId: string, injectText: string) => void;
}

export interface PruneArgs {
  quote: string;
  note_type: NoteType;
  fruit: unknown;
  keep_code: boolean;
}

export interface PruneToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handlePrune(context: MekiriToolsContext, args: PruneArgs): Promise<PruneToolResult> {
  const validation = validateFruit({
    noteType: args.note_type,
    fruit: args.fruit,
    keepCode: args.keep_code,
  });
  if (!validation.ok) {
    return { content: [{ type: "text", text: `invalid fruit: ${validation.errors.join("; ")}` }], isError: true };
  }

  const transcript = context.getTranscript();
  const boundary = findBoundary(transcript, args.quote);
  if (boundary.status !== "ok") {
    return { content: [{ type: "text", text: JSON.stringify(boundary) }] };
  }

  const boundaryIndex = transcript.findIndex((line) => line.uuid === boundary.uuid);
  const removedLines = boundaryIndex >= 0 ? transcript.slice(boundaryIndex + 1) : [];
  const removedBranchLength = JSON.stringify(removedLines).length;
  const fruitLength = JSON.stringify(validation.fruit).length;

  const { newSessionId } = await createBranch({
    branchType: "prune",
    sessionId: context.getSessionId(),
    dir: context.dir,
    upToMessageId: boundary.uuid,
    noteType: args.note_type,
    removedBranchLength,
    fruitLength,
    auditProjectDir: context.dir,
  });

  const injectText = [
    "[branch_type:prune, branch archived, resuming from fruit]",
    JSON.stringify({ note_type: args.note_type, fruit: validation.fruit }, null, 2),
  ].join("\n");

  context.onSwitch(newSessionId, injectText);

  return { content: [{ type: "text", text: `ok: new_session_id=${newSessionId}` }] };
}

export function createMekiriTools(context: MekiriToolsContext): McpSdkServerConfigWithInstance {
  const pruneTool = tool(
    "prune",
    "Cut the dirty tail of the current session: archive it and continue from a distilled note. Use when a side investigation is done and its raw process is no longer needed.",
    {
      quote: z.string().describe("Verbatim opening sentence of your own turn where the garbage begins"),
      note_type: z.enum(["portal", "death_reload"]),
      fruit: z.record(z.string(), z.unknown()).describe("portal: {summary, files_touched?, gotchas?}. death_reload: {tried, ruled_out, facts_learned?, trigger?}"),
      keep_code: z.boolean().default(true),
    },
    async (args) => (await handlePrune(context, args as PruneArgs)) as CallToolResult,
  );

  return createSdkMcpServer({ name: "mekiri", version: "0.1.0", tools: [pruneTool] });
}
