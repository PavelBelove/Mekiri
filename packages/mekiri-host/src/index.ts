export const PACKAGE_NAME = "mekiri-host";
export { runRepl } from "./repl.js";
export type { ReplOptions } from "./repl.js";

function parseArgs(argv: string[]): { resumeSessionId?: string; dir: string } {
  let resumeSessionId: string | undefined;
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) {
      resumeSessionId = argv[i + 1];
      i++;
    } else if (argv[i] === "--dir" && argv[i + 1]) {
      dir = argv[i + 1];
      i++;
    }
  }
  return { resumeSessionId, dir };
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const { runRepl } = await import("./repl.js");
  const { resumeSessionId, dir } = parseArgs(process.argv.slice(2));
  await runRepl({ resumeSessionId, dir });
}
