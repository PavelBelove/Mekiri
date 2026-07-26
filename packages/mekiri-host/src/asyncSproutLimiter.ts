export interface AsyncSproutLimiter {
  tryAcquire(limit: number): boolean;
  release(): void;
  readonly active: number;
}

/**
 * Tracks how many background (wait_mode:'async') clones are currently in
 * flight, shared across the parent and every clone in the same process
 * (see tools.ts's MekiriToolsContext.asyncSproutLimiter). The limit itself
 * is not stored here -- it's passed to tryAcquire() fresh on every call, so
 * a live sprout.parallelism config change takes effect immediately without
 * needing to recreate this object.
 */
export function createAsyncSproutLimiter(): AsyncSproutLimiter {
  let active = 0;
  return {
    tryAcquire(limit: number): boolean {
      if (active >= limit) return false;
      active++;
      return true;
    },
    release(): void {
      active = Math.max(0, active - 1);
    },
    get active(): number {
      return active;
    },
  };
}
