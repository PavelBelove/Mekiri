import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInputQueue } from "../src/inputQueue.js";
import { createMekiriTools } from "../src/tools.js";
import { canUseTool } from "../src/repl.js";
import type { RawLine } from "mekiri-core";

// Session-file test helper mirroring test/tools.test.ts's convention (same
// CLAUDE_CONFIG_DIR + dir + slash-to-dash sanitization, verified against the
// compiled SDK during mekiri-core's Task 7).
function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}
async function writeSessionFile(configDir: string, dir: string, sessionId: string, lines: RawLine[]): Promise<void> {
  const { promises: fs } = await import("node:fs");
  const filePath = path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

// The SDK resolves auth credentials from CLAUDE_CONFIG_DIR/.credentials.json
// (falling back to ~/.claude when CLAUDE_CONFIG_DIR is unset). Overriding
// CLAUDE_CONFIG_DIR to an empty temp dir (needed so mekiri's session-file
// reads are isolated to the fixture, same as tools.test.ts) otherwise makes
// a real query() fail with "Not logged in" — so copy the real credentials
// file into the fixture config dir too. Best-effort: if it's missing (e.g.
// CI using a different auth mechanism), let query() surface its own error.
async function copyRealCredentials(configDir: string): Promise<void> {
  try {
    await copyFile(path.join(homedir(), ".claude", ".credentials.json"), path.join(configDir, ".credentials.json"));
  } catch {
    // no credentials file to copy; fall through and let query() report auth failure
  }
}

// These tests make real, billed API calls. Keep them to the minimum needed
// to prove the wiring this task adds actually works end to end — everything
// beyond this is manual dogfooding per the design spec's explicit choice.
describe("mekiri-host live smoke test", () => {
  it("completes one real turn, captures a session id, and receives assistant text", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let sessionId: string | undefined;
    let sawAssistantText = false;

    const q = query({ prompt: iterable, options: { cwd: process.cwd() } });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantText).toBe(true);
  }, 60_000);

  it("resumes a session by id and the resumed query's init message reports the same session id", async () => {
    const first = createInputQueue();
    first.push("Reply with exactly one word: ok");
    first.close();

    let firstSessionId: string | undefined;
    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") firstSessionId = message.session_id;
    }
    expect(firstSessionId).toBeTruthy();

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    const q2 = query({ prompt: second.iterable, options: { resume: firstSessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") secondSessionId = message.session_id;
    }

    expect(secondSessionId).toBe(firstSessionId);
  }, 60_000);

  it("mid-turn: calling q.return() after the first assistant message, then resuming, picks up the same session cleanly", async () => {
    const first = createInputQueue();
    first.push("Count from 1 to 10, one number per line.");
    first.close();

    let sessionId: string | undefined;
    let sawAssistantMessage = false;

    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }

      if (message.type === "assistant") {
        sawAssistantMessage = true;
      }

      // Mirrors repl.ts's actual pendingSwitch path: interrupt mid-turn as
      // soon as we've seen a real assistant message, rather than letting the
      // generator exhaust naturally.
      if (sawAssistantMessage) {
        await q1.return(undefined);
        break;
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantMessage).toBe(true);

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    let sawAssistantText = false;

    const q2 = query({ prompt: second.iterable, options: { resume: sessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") {
        secondSessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(secondSessionId).toBe(sessionId);
    expect(sawAssistantText).toBe(true);
  }, 60_000);
});

// Regression test for the hang found via manual dogfooding: repl.ts wires
// mcpServers: { mekiri: tools } into query() but, without a canUseTool
// callback, the SDK falls back to interactive permission prompting with no
// UI to answer it — a real `prune` call from the model would hang forever.
// This test runs the exact same mcpServers + canUseTool wiring repl.ts uses
// (importing canUseTool from ../src/repl.js, not reimplementing it) and
// drives the model to actually call the tool, asserting it reaches
// completion (onSwitch fires) instead of hanging.
describe("mekiri-host live smoke test: prune tool permission wiring", () => {
  const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const U1_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const A1_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const A2_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const BOUNDARY_QUOTE = "Reading the logs now, this is the boundary.";

  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let transcriptLines: RawLine[];

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-repl-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-repl-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await copyRealCredentials(configDir);

    transcriptLines = [
      { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: BOUNDARY_QUOTE }] } },
      { type: "assistant", uuid: A2_UUID, parentUuid: A1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "More garbage after the boundary." }] } },
    ];
    await writeSessionFile(configDir, projectDir, SESSION_ID, transcriptLines);
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("a real model turn that calls prune completes (onSwitch fires) instead of hanging on a permission prompt", async () => {
    const switchCalls: Array<{ newSessionId: string; injectText: string }> = [];

    const tools = createMekiriTools({
      dir: projectDir,
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId, injectText) => {
        switchCalls.push({ newSessionId, injectText });
      },
    });

    const { iterable, push, close } = createInputQueue();
    push(
      [
        "Call the prune tool (mcp__mekiri__prune) right now, in this turn, with exactly these arguments and no others:",
        `quote: "${BOUNDARY_QUOTE}"`,
        'note_type: "portal"',
        'fruit: {"summary": "smoke test prune", "files_touched": []}',
        "keep_code: true",
        "The mcp__mekiri__prune tool is already directly available to you — do not use ToolSearch or any other lookup tool first, and do not call any other tool. Make mcp__mekiri__prune your first and only tool call, immediately. Do not ask for permission or confirmation, and do not explain what you are about to do first — just make the tool call.",
      ].join("\n"),
    );
    close();

    let sawToolResult = false;

    const q = query({
      prompt: iterable,
      options: {
        cwd: projectDir,
        mcpServers: { mekiri: tools },
        canUseTool,
      },
    });

    for await (const message of q) {
      if (message.type === "user") {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
              sawToolResult = true;
            }
          }
        }
      }
    }

    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).not.toBe(SESSION_ID);
    expect(switchCalls[0].injectText).toContain("smoke test prune");
    expect(sawToolResult).toBe(true);
  }, 60_000);
});
