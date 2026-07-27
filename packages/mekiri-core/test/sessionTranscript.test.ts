import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeDir, readSessionTranscript } from "../src/sessionTranscript.js";
import type { RawLine } from "../src/types.js";

describe("sanitizeDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(sanitizeDir("/home/pol/dev/rollback")).toBe("-home-pol-dev-rollback");
  });
});

describe("readSessionTranscript", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;
  const projectDir = "/fake/project/dir";
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-core-transcript-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  it("returns [] when the session file doesn't exist", async () => {
    const lines = await readSessionTranscript(projectDir, sessionId);
    expect(lines).toEqual([]);
  });

  it("reads and parses a real session file", async () => {
    const lines: RawLine[] = [
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    const dirPath = path.join(configDir, "projects", sanitizeDir(projectDir));
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const result = await readSessionTranscript(projectDir, sessionId);
    expect(result).toEqual(lines);
  });
});
