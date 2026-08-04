import { describe, it, expect, vi } from "vitest";
import { createToolHandlers } from "../src/mcpServer.js";
import { spawnClone } from "../src/spawnClone.js";

const FIXTURE_TRANSCRIPT = [
  { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "the answer is 42" }] } },
];

vi.mock("mekiri-core", async () => {
  const actual = await vi.importActual<typeof import("mekiri-core")>("mekiri-core");
  return {
    ...actual,
    readSessionTranscript: vi.fn(async () => FIXTURE_TRANSCRIPT),
    appendAuditEntry: vi.fn(async () => {}),
    loadConfig: vi.fn(async () => actual.defaultConfig()),
  };
});

vi.mock("../src/spawnClone.js", () => ({
  spawnClone: vi.fn(async () => ({ childSessionId: "child-1", result: "done" })),
}));

describe("prune handler", () => {
  it("registers a rule with the daemon when the quote resolves unambiguously", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({
      sessionId: "s1",
      dir: "/proj",
      depth: 0,
      daemonPort: 8791,
      postControlRule,
    });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "found the answer" },
      keep_code: false,
    });

    expect(result.status).toBe("ok");
    expect(result).toMatchObject({ cut_effective_from: "next_request" });
    if (result.status !== "ok") throw new Error("unreachable");
    expect(typeof result.rule_id).toBe("string");
    expect(result.distillate).toContain("found the answer");

    expect(postControlRule).toHaveBeenCalledTimes(1);
    expect(postControlRule.mock.calls[0][0].sessionId).toBe("s1");
    expect(postControlRule.mock.calls[0][0].rule).toEqual({ id: result.rule_id, matchQuote: "the answer is 42" });
  });

  it("generates a distinct rule_id for each prune call", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({
      sessionId: "s1",
      dir: "/proj",
      depth: 0,
      daemonPort: 8791,
      postControlRule,
    });

    const first = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "first" },
      keep_code: false,
    });
    const second = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "second" },
      keep_code: false,
    });

    if (first.status !== "ok" || second.status !== "ok") throw new Error("unreachable");
    expect(first.rule_id).not.toBe(second.rule_id);
  });

  it("returns invalid_fruit without calling the daemon when fruit fails validation", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 0, daemonPort: 8791, postControlRule });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: {},
      keep_code: false,
    });

    expect(result.status).toBe("invalid_fruit");
    expect(postControlRule).not.toHaveBeenCalled();
  });
});

describe("sprout handler", () => {
  it("returns depth_limit_exceeded when own depth is at the configured limit", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 1, daemonPort: 8791, postControlRule: vi.fn() });
    // default config's sprout.depth_limit is 1 (see mekiri-core's defaultConfig) -- depth 1 means already at the ceiling
    const result = await handlers.sprout({ task: "investigate X" });
    expect(result).toEqual({ status: "depth_limit_exceeded" });
    expect(spawnClone).not.toHaveBeenCalled();
  });

  it("returns async_not_supported without calling spawnClone when wait_mode is async", async () => {
    vi.mocked(spawnClone).mockClear();
    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const result = await handlers.sprout({ task: "investigate X", wait_mode: "async" });
    expect(result).toEqual({ status: "async_not_supported" });
    expect(spawnClone).not.toHaveBeenCalled();
  });

  it("forks a clone and records the real transcript length as branchLength on success", async () => {
    vi.mocked(spawnClone).mockClear();
    const { appendAuditEntry } = await import("mekiri-core");
    vi.mocked(appendAuditEntry).mockClear();

    const handlers = createToolHandlers({ sessionId: "s1", dir: "/proj", depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const result = await handlers.sprout({ task: "investigate X" });

    expect(result).toEqual({ status: "ok", child_session_id: "child-1", result: "done" });
    expect(spawnClone).toHaveBeenCalledTimes(1);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditEntry).mock.calls[0][1] as { branchLength: number };
    expect(entry.branchLength).toBe(JSON.stringify(FIXTURE_TRANSCRIPT).length);
    expect(entry.branchLength).toBeGreaterThan(0);
  });
});
