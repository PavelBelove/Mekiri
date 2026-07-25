import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawLine } from "mekiri-core";

// handlePrune calls mekiri-core's createBranch(), which internally calls the
// Agent SDK's forkSession(). forkSession reads the source session's
// transcript straight off disk, but the SDK streams SDKAssistantMessage
// objects to this process before the underlying CLI subprocess has
// necessarily flushed the matching line to that file — so forkSession can
// transiently throw `Error("Message <uuid> not found in session <id>")` for
// a message that legitimately exists and lands on disk moments later. This
// was reproduced empirically against the real SDK (see task report); this
// test constructs the same failure mode deterministically by mocking
// mekiri-core's createBranch to reject with that exact error shape a
// controlled number of times before succeeding, so we can assert
// handlePrune's retry behavior without depending on real disk-flush timing.
const createBranchMock = vi.fn();

vi.mock("mekiri-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mekiri-core")>();
  return {
    ...actual,
    createBranch: createBranchMock,
  };
});

const { handlePrune } = await import("../src/tools.js");

const U1_UUID = "77777777-7777-4777-8777-777777777777";
const A1_UUID = "88888888-8888-4888-8888-888888888888";
const SESSION_ID = "66666666-6666-4666-8666-666666666666";

function notFoundError(): Error {
  return new Error(`Message ${A1_UUID} not found in session ${SESSION_ID}`);
}

function makeContext(switchCalls: Array<{ newSessionId: string; injectText: string }>) {
  const transcriptLines: RawLine[] = [
    { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
    { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Reading the logs now, this is the boundary." }] } },
  ];
  return {
    dir: "/tmp/irrelevant",
    getSessionId: () => SESSION_ID,
    getTranscript: () => transcriptLines,
    onSwitch: (newSessionId: string, injectText: string) => {
      switchCalls.push({ newSessionId, injectText });
    },
  };
}

const pruneArgs = {
  quote: "Reading the logs now, this is the boundary",
  note_type: "portal" as const,
  fruit: { summary: "Found the cause, fixed it.", files_touched: [{ path: "src/foo.ts", change: "fix" }] },
  keep_code: true,
};

describe("handlePrune retries the transient forkSession race", () => {
  beforeEach(() => {
    createBranchMock.mockReset();
  });

  it("retries on 'not found in session' and succeeds once the race clears", async () => {
    createBranchMock
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockResolvedValueOnce({ newSessionId: "new-session-id" });

    const switchCalls: Array<{ newSessionId: string; injectText: string }> = [];
    const result = await handlePrune(makeContext(switchCalls), pruneArgs);

    expect(result.isError).toBeFalsy();
    expect(createBranchMock).toHaveBeenCalledTimes(3);
    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).toBe("new-session-id");
  });

  it("returns a clear isError result (does not throw) when every retry is exhausted", async () => {
    createBranchMock.mockRejectedValue(notFoundError());

    const switchCalls: Array<{ newSessionId: string; injectText: string }> = [];
    const result = await handlePrune(makeContext(switchCalls), pruneArgs);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("prune failed");
    expect(result.content[0].text).toContain("not found in session");
    // initial attempt + 4 configured retries
    expect(createBranchMock).toHaveBeenCalledTimes(5);
    expect(switchCalls).toHaveLength(0);
  }, 10000);

  it("does not retry non-transient errors — fails on the first attempt", async () => {
    createBranchMock.mockRejectedValue(new Error("some unrelated failure"));

    const switchCalls: Array<{ newSessionId: string; injectText: string }> = [];
    const result = await handlePrune(makeContext(switchCalls), pruneArgs);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("prune failed: some unrelated failure");
    expect(createBranchMock).toHaveBeenCalledTimes(1);
    expect(switchCalls).toHaveLength(0);
  });
});
