import { spawn } from "node:child_process";

export interface SpawnCloneArgs {
  sessionId: string;
  task: string;
  dir: string;
  proxyPort: number;
  depth: number;
  claudeBin?: string;
  /** Test-only escape hatch: extra argv entries inserted before the real
   *  claude CLI flags, used to point at a fixture script instead of the
   *  real binary. Always `[]` in production. */
  claudeArgsPrefix?: string[];
}

export interface SpawnCloneResult {
  childSessionId: string;
  result: string;
}

const FORK_RETRY_DELAYS_MS = [50, 100, 200, 400];

function frameTask(task: string): string {
  return (
    "Ты — тёплый клон родительской сессии Mekiri. Унаследованный контекст — актив, не балласт. " +
    "Задача считается завершённой только после того, как ты вернёшь итоговый результат родителю.\n\n" +
    `Задача: ${task}`
  );
}

function runOnce(args: SpawnCloneArgs): Promise<SpawnCloneResult> {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      ...(args.claudeArgsPrefix ?? []),
      "--resume",
      args.sessionId,
      "--fork-session",
      "-p",
      frameTask(args.task),
      "--output-format",
      "json",
    ];
    const child = spawn(args.claudeBin ?? "claude", cliArgs, {
      cwd: args.dir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${args.proxyPort}`,
        MEKIRI_SPROUT_DEPTH: String(args.depth),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `clone process exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ childSessionId: parsed.session_id, result: parsed.result });
      } catch {
        reject(new Error(`clone process produced non-JSON output: ${stdout}`));
      }
    });
    child.on("error", reject);
  });
}

function isTransientForkError(err: unknown): boolean {
  return err instanceof Error && /not found in session/.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnClone(args: SpawnCloneArgs): Promise<SpawnCloneResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(args);
    } catch (err) {
      const attemptsLeft = attempt < FORK_RETRY_DELAYS_MS.length;
      if (!isTransientForkError(err) || !attemptsLeft) throw err;
      await sleep(FORK_RETRY_DELAYS_MS[attempt]);
    }
  }
}
