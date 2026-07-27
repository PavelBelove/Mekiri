import { forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionBackend, ForkOptions, ForkResult, SessionId } from "./executionBackend.js";

export function createClaudeCodeBackend(): ExecutionBackend {
  return {
    async forkSession(sessionId: SessionId, options: ForkOptions): Promise<ForkResult> {
      const result = await sdkForkSession(sessionId, { dir: options.dir, upToMessageId: options.upToMessageId });
      return { newSessionId: result.sessionId };
    },
  };
}
