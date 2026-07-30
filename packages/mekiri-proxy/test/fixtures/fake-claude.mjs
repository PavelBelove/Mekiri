// Stands in for the real `claude` CLI in tests: echoes back a JSON result
// shaped like `claude -p ... --output-format json` would, without touching
// the network. Fails on its first invocation (tracked via a marker file
// passed as FAKE_CLAUDE_FAIL_ONCE_MARKER) to exercise the retry path.
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const marker = process.env.FAKE_CLAUDE_FAIL_ONCE_MARKER;
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "1");
  process.stderr.write("Error: Message abc-123 not found in session xyz\n");
  process.exit(1);
}
if (marker) unlinkSync(marker);

process.stdout.write(JSON.stringify({ session_id: "child-session-456", result: "clone finished the task" }));
process.exit(0);
