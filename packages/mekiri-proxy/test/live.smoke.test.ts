import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemon } from "../src/daemon.js";
import { postControlRuleOverHttp } from "../src/mcpServer.js";

// The daemon under test (`createDaemon`) runs in-process, on this same
// event loop -- it is not a separate process. `execFileSync` blocks the
// entire event loop until the child exits, so if we used it here, the
// `claude` child's HTTP requests to 127.0.0.1:PORT would have no event
// loop left to be served by while we synchronously wait for that same
// child -- a guaranteed deadlock (confirmed by hand: with execFileSync,
// `claude -p` hangs forever and never even reaches turn 1). `execFile`
// (promisified) keeps this process's event loop free while the child
// runs, which is what actually lets the daemon answer it.
const execFileAsync = promisify(execFile);

// Requires a real, authenticated `claude` CLI on PATH and the owner's
// explicit, already-granted acceptance of routing subscription traffic
// through a local relay for testing (see wire-prune-findings.md §3). Not
// part of the default suite -- run explicitly via `npm run test:live`.
describe("live smoke test", () => {
  let stateDir: string;
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  const PORT = 18999;

  beforeAll(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-live-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
    daemon = await createDaemon({ port: PORT, upstream: { protocol: "https", host: "api.anthropic.com", port: 443 } });
  });

  afterAll(async () => {
    await daemon.close();
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("prompt caching survives a tail cut applied through the real daemon", async () => {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}` };

    const { stdout: turn1Stdout } = await execFileAsync(
      "claude",
      ["-p", "Turn 1. Reply with exactly: ACK 1", "--output-format", "json"],
      { env }
    );
    const turn1 = JSON.parse(turn1Stdout);
    const sessionId = turn1.session_id;

    for (const n of [2, 3]) {
      await execFileAsync(
        "claude",
        ["--resume", sessionId, "-p", `Turn ${n}. Reply with exactly: ACK ${n}`, "--output-format", "json"],
        { env }
      );
    }

    await postControlRuleOverHttp(PORT)({
      sessionId,
      dir: process.cwd(),
      rule: {
        matchQuote: "ACK 2",
        replacement: [
          { role: "user", content: "[MEKIRI PORTAL] cut everything before this." },
          { role: "assistant", content: "distillate: turns 1-2 were a numbering test." },
        ],
      },
    });

    const { stdout: afterCutStdout } = await execFileAsync(
      "claude",
      ["--resume", sessionId, "-p", "Turn 4. Reply with exactly: ACK 4", "--output-format", "json"],
      { env }
    );
    const afterCut = JSON.parse(afterCutStdout);

    expect(afterCut.usage.cache_read_input_tokens).toBeGreaterThan(0);
  }, 60000);
});
