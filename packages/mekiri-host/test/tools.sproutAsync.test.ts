import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionBackend } from "mekiri-core";

// This file covers wait_mode:'async' handleSprout failure paths that were
// found and fixed via live dogfooding (see tools.ts's comments right above
// the fork call and inside the runClone().then() callback) but never had
// unit coverage, because exercising them for real would mean either a real
// SDK fork race or a real disk failure. ExecutionBackend and runClone are
// both already seams injected into handleSprout (backend via context,
// runClone via "./clone.js"), so both can be faked/mocked here instead of
// depending on the real Agent SDK -- no live, billed query() call needed.
//
// Three distinct failure modes exercised, matching the three separate
// error-handling spots in handleSprout's async branch:
//   1. forkSession itself rejects (before any clone ever starts).
//   2. runClone rejects (the clone started but crashed / never harvested).
//   3. runClone succeeds, but the best-effort appendAuditEntry afterwards
//      rejects -- this must NOT be reported to the parent as a clone
//      failure, per the comment on lines ~253-259 of tools.ts.
const runCloneMock = vi.fn();
vi.mock("../src/clone.js", () => ({
  runClone: runCloneMock,
}));

const appendAuditEntryMock = vi.fn();
vi.mock("mekiri-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mekiri-core")>();
  return {
    ...actual,
    appendAuditEntry: appendAuditEntryMock,
  };
});

const { handleSprout } = await import("../src/tools.js");
const { createAsyncSproutLimiter } = await import("../src/asyncSproutLimiter.js");

function fakeBackend(forkSession: ExecutionBackend["forkSession"]): ExecutionBackend {
  return { forkSession };
}

describe("handleSprout wait_mode:'async' failure paths", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-async-"));
    runCloneMock.mockReset();
    appendAuditEntryMock.mockReset();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeContext(opts: {
    backend: ExecutionBackend;
    asyncSproutLimiter: ReturnType<typeof createAsyncSproutLimiter>;
    onAsyncSproutComplete: (injectText: string) => void;
  }) {
    return {
      dir: projectDir,
      depth: 0,
      isClone: false,
      backend: opts.backend,
      getSessionId: () => "parent-session-id",
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("onSwitch should not be called from an async-sprout test");
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from an async-sprout test (parent-side handleSprout, not the clone)");
      },
      asyncSproutLimiter: opts.asyncSproutLimiter,
      onAsyncSproutComplete: opts.onAsyncSproutComplete,
    };
  }

  it("releases the parallelism slot and propagates the error when forkSession itself rejects", async () => {
    const forkSession = vi.fn().mockRejectedValue(new Error("fork boom: session not found"));
    const limiter = createAsyncSproutLimiter();
    const onAsyncSproutComplete = vi.fn();

    const context = makeContext({ backend: fakeBackend(forkSession), asyncSproutLimiter: limiter, onAsyncSproutComplete });

    await expect(handleSprout(context, { task: "irrelevant", wait_mode: "async" })).rejects.toThrow("fork boom: session not found");

    // The slot acquired by tryAcquire() before the fork attempt must be
    // released on the throw path, not leaked -- otherwise a single failed
    // fork would permanently eat one unit of async parallelism.
    expect(limiter.active).toBe(0);
    expect(runCloneMock).not.toHaveBeenCalled();
    expect(appendAuditEntryMock).not.toHaveBeenCalled();
    expect(onAsyncSproutComplete).not.toHaveBeenCalled();
  });

  it("delivers an async error message and releases the slot when runClone itself rejects", async () => {
    const forkSession = vi.fn().mockResolvedValue({ newSessionId: "child-session-id" });
    runCloneMock.mockRejectedValue(new Error("clone crashed before harvesting"));
    const limiter = createAsyncSproutLimiter();

    let resolveComplete!: (injectText: string) => void;
    const completePromise = new Promise<string>((resolve) => {
      resolveComplete = resolve;
    });
    const onAsyncSproutComplete = vi.fn((injectText: string) => resolveComplete(injectText));

    const context = makeContext({ backend: fakeBackend(forkSession), asyncSproutLimiter: limiter, onAsyncSproutComplete });

    const immediate = await handleSprout(context, { task: "irrelevant", wait_mode: "async" });
    const parsedImmediate = JSON.parse((immediate.content[0] as { text: string }).text);
    expect(parsedImmediate.status).toBe("ok");
    expect(parsedImmediate.pending).toBe(true);
    expect(parsedImmediate.child_session_id).toBe("child-session-id");

    const injectText = await completePromise;

    expect(injectText).toContain("child-session-id");
    expect(injectText).toContain("clone crashed before harvesting");
    expect(injectText).toContain("did not harvest");
    expect(limiter.active).toBe(0);
    expect(appendAuditEntryMock).not.toHaveBeenCalled();
  });

  it("still reports a successful harvest via onAsyncSproutComplete when the audit-log write afterwards fails", async () => {
    const forkSession = vi.fn().mockResolvedValue({ newSessionId: "child-session-id" });
    runCloneMock.mockResolvedValue({
      result: "the real harvested result",
      harvestedImplicitly: false,
      needsCleanLook: false,
      branchLength: 4242,
    });
    appendAuditEntryMock.mockRejectedValue(new Error("disk full"));
    const limiter = createAsyncSproutLimiter();

    let resolveComplete!: (injectText: string) => void;
    const completePromise = new Promise<string>((resolve) => {
      resolveComplete = resolve;
    });
    const onAsyncSproutComplete = vi.fn((injectText: string) => resolveComplete(injectText));

    const context = makeContext({ backend: fakeBackend(forkSession), asyncSproutLimiter: limiter, onAsyncSproutComplete });

    const immediate = await handleSprout(context, { task: "irrelevant", wait_mode: "async" });
    const parsedImmediate = JSON.parse((immediate.content[0] as { text: string }).text);
    expect(parsedImmediate.pending).toBe(true);

    const injectText = await completePromise;

    // The critical assertion: a failed audit write must not masquerade as a
    // failed clone. The parent must still see the real harvested result,
    // not formatAsyncSproutError's "did not harvest" message.
    expect(injectText).toContain("the real harvested result");
    expect(injectText).not.toContain("did not harvest");
    expect(appendAuditEntryMock).toHaveBeenCalledTimes(1);
    expect(limiter.active).toBe(0);
  });
});
