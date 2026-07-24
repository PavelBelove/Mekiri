import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlePrune } from "../src/tools.js";
import type { RawLine } from "mekiri-core";

// Session-file test helpers mirroring mekiri-core's test/helpers/sessionFile.ts
// (same CLAUDE_CONFIG_DIR + dir + slash-to-dash sanitization convention,
// verified during mekiri-core's Task 7 against the compiled SDK).
function sanitizeDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}
async function writeSessionFile(configDir: string, dir: string, sessionId: string, lines: RawLine[]): Promise<void> {
  const { promises: fs } = await import("node:fs");
  const filePath = path.join(configDir, "projects", sanitizeDir(dir), `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const U1_UUID = "77777777-7777-4777-8777-777777777777";
const A1_UUID = "88888888-8888-4888-8888-888888888888";
const A2_UUID = "99999999-9999-4999-8999-999999999999";

describe("handlePrune", () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let switchCalls: Array<{ newSessionId: string; injectText: string }>;
  let transcriptLines: RawLine[];

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    switchCalls = [];

    transcriptLines = [
      { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Reading the logs now, this is the boundary." }] } },
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

  function makeContext() {
    return {
      dir: projectDir,
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId: string, injectText: string) => {
        switchCalls.push({ newSessionId, injectText });
      },
    };
  }

  it("prunes successfully, calls onSwitch with a new session id, and reports ok", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: { summary: "Found the cause, fixed it.", files_touched: [{ path: "src/foo.ts", change: "fix" }] },
      keep_code: true,
    });

    expect(result.isError).toBeFalsy();
    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).not.toBe(SESSION_ID);
    expect(switchCalls[0].injectText).toContain("Found the cause, fixed it.");
  });

  it("returns an error result and does not call onSwitch when fruit validation fails", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: {}, // missing required summary
      keep_code: true,
    });

    expect(result.isError).toBe(true);
    expect(switchCalls).toHaveLength(0);
  });

  it("reports not_found and does not call onSwitch when the quote doesn't match", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "this text does not appear anywhere in the transcript",
      note_type: "portal",
      fruit: { summary: "irrelevant" },
      keep_code: false,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("not_found");
    expect(switchCalls).toHaveLength(0);
  });
});
