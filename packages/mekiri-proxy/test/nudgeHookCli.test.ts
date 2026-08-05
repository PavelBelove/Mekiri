import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(__dirname, "..", "bin", "nudge-hook.ts");

function runHook(input: unknown, cwd: string): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", HOOK_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode }));
    child.stdin.write(JSON.stringify({ ...input, cwd }));
    child.stdin.end();
  });
}

describe("nudge-hook CLI", () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("writes fresh state and prints nothing on the first (non-mekiri) call", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "nudge-hook-test-"));
    const sessionId = "session-a";

    const { stdout, exitCode } = await runHook({ session_id: sessionId, tool_name: "Read" }, workDir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");

    const statePath = path.join(workDir, ".mekiri", "hook-state", `${sessionId}.json`);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.callsSinceReset).toBe(0);
    expect(state.threshold).toBeGreaterThanOrEqual(2);
  });

  it("fires the nudge once enough non-mekiri calls accumulate", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "nudge-hook-test-"));
    const sessionId = "session-b";
    const statePath = path.join(workDir, ".mekiri", "hook-state", `${sessionId}.json`);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ callsSinceReset: 1, threshold: 2 }), "utf8");

    const { stdout, exitCode } = await runHook({ session_id: sessionId, tool_name: "Bash" }, workDir);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Mekiri");

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.callsSinceReset).toBe(0);
  });

  it("silently exits 0 on malformed stdin", async () => {
    const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", HOOK_BIN], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ stdout: out, exitCode }));
      child.stdin.write("{not valid json");
      child.stdin.end();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});
