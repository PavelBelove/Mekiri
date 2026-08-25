import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(__dirname, "..", "bin", "stop-hook.ts");

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

describe("stop-hook CLI", () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("emits nothing and writes no stopBoundary when stopHook.enabled is absent from config (kill-switch default off)", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "stop-hook-test-"));
    const sessionId = "session-disabled";

    const { stdout, exitCode } = await runHook(
      { session_id: sessionId, last_assistant_message: "final report", stop_hook_active: false },
      workDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");

    const statePath = path.join(workDir, ".mekiri", "hook-state", `${sessionId}.json`);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.stopBoundary).toBeUndefined();
  });

  it("emits a block decision and persists stopBoundary when enabled and not already in a forced continuation", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "stop-hook-test-"));
    const sessionId = "session-enabled";
    const configPath = path.join(workDir, ".mekiri", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ stopHook: { enabled: true } }), "utf8");

    const { stdout, exitCode } = await runHook(
      { session_id: sessionId, last_assistant_message: "final report text", stop_hook_active: false },
      workDir,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("prune");

    const statePath = path.join(workDir, ".mekiri", "hook-state", `${sessionId}.json`);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.stopBoundary.lastAssistantMessage).toBe("final report text");
  });

  it("does not block when stop_hook_active is already true, even with the kill-switch on", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "stop-hook-test-"));
    const sessionId = "session-loopguard";
    const configPath = path.join(workDir, ".mekiri", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ stopHook: { enabled: true } }), "utf8");

    const { stdout, exitCode } = await runHook(
      { session_id: sessionId, last_assistant_message: "final report", stop_hook_active: true },
      workDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("preserves existing nudge state untouched while setting stopBoundary", async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "stop-hook-test-"));
    const sessionId = "session-preserve-nudge";
    const configPath = path.join(workDir, ".mekiri", "config.json");
    const statePath = path.join(workDir, ".mekiri", "hook-state", `${sessionId}.json`);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ stopHook: { enabled: true } }), "utf8");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ nudge: { callsSinceReset: 3, threshold: 7 } }), "utf8");

    const { exitCode } = await runHook(
      { session_id: sessionId, last_assistant_message: "report", stop_hook_active: false },
      workDir,
    );

    expect(exitCode).toBe(0);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.nudge).toEqual({ callsSinceReset: 3, threshold: 7 });
    expect(state.stopBoundary.lastAssistantMessage).toBe("report");
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
