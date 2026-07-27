/**
 * ACP-shaped ids -- string aliases today (mirror Claude Code's own uuid
 * strings), documented separately so the eventual real ACP SessionId/
 * MessageId types can replace them without touching call sites.
 */
export type SessionId = string;
export type MessageId = string;

export interface ForkOptions {
  dir: string;
  /** Present only for prune (fork up to a specific point); absent for sprout (fork the current end of history). */
  upToMessageId?: MessageId;
}

export interface ForkResult {
  newSessionId: SessionId;
}

/**
 * The execution-layer seam tz.md §2/§10 calls for: the one live operation
 * mekiri-core's prune/sprout logic needs from "wherever sessions actually
 * live" -- forking. Today's only implementation is ClaudeCodeBackend
 * (claudeCodeBackend.ts), wrapping the Agent SDK's forkSession. A future
 * ACP backend implements the same interface against a live proxy instead --
 * Phase 3, not built here.
 */
export interface ExecutionBackend {
  forkSession(sessionId: SessionId, options: ForkOptions): Promise<ForkResult>;
}
