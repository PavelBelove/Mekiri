import { promises as fs } from "node:fs";
import path from "node:path";

// Observation-only spike for evaluating a `Stop`-hook-forced closing prune.
// Never blocks, never calls any Mekiri tool -- just records what Claude Code
// actually hands the hook, so the open questions from docs (is the final
// assistant message already flushed to transcript_path by the time Stop
// fires; what fields the payload carries; how much latency the hook itself
// adds) can be answered empirically instead of guessed. Delete once answered.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function tailTranscript(transcriptPath: string | undefined, lines: number): Promise<string> {
  if (!transcriptPath) return "(no transcript_path in payload)";
  try {
    const raw = await fs.readFile(transcriptPath, "utf8");
    const allLines = raw.split("\n").filter((l) => l.trim() !== "");
    return allLines.slice(-lines).join("\n");
  } catch (err) {
    return `(failed to read transcript_path: ${String(err)})`;
  }
}

async function main(): Promise<void> {
  const receivedAt = new Date().toISOString();
  const raw = await readStdin();

  let input: { transcript_path?: string; [key: string]: unknown };
  try {
    input = JSON.parse(raw) as typeof input;
  } catch {
    input = {};
  }

  const transcriptTail = await tailTranscript(input.transcript_path, 2);
  const finishedAt = new Date().toISOString();

  const logPath = path.join(process.cwd(), ".mekiri", "stop-hook-spike.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const entry =
    `\n===== Stop hook fired: ${receivedAt} =====\n` +
    `raw stdin:\n${raw}\n\n` +
    `transcript_path tail (last 2 lines):\n${transcriptTail}\n\n` +
    `hook processing finished: ${finishedAt}\n`;
  await fs.appendFile(logPath, entry, "utf8");

  // Deliberately never emits a block decision -- observation only.
}

main().catch(() => {
  process.exit(0);
});
