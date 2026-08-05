import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// recordDistillate/readReportRange/readCapsule/findCapsuleEntry are left as
// the real mekiri-core implementations (see the partial mock above) -- they
// only touch files under `dir`, so a real per-test temp dir keeps that
// filesystem I/O local and isolated instead of hitting a fake absolute path
// like the pre-existing tests' old "/proj" fixture would.
let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "mekiri-mcpserver-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("prune handler", () => {
  it("registers a rule with the daemon when the quote resolves unambiguously", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({
      sessionId: "s1",
      dir: projectDir,
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
      dir: projectDir,
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
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule });

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
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 1, daemonPort: 8791, postControlRule: vi.fn() });
    // default config's sprout.depth_limit is 1 (see mekiri-core's defaultConfig) -- depth 1 means already at the ceiling
    const result = await handlers.sprout({ task: "investigate X" });
    expect(result).toEqual({ status: "depth_limit_exceeded" });
    expect(spawnClone).not.toHaveBeenCalled();
  });

  it("returns async_not_supported without calling spawnClone when wait_mode is async", async () => {
    vi.mocked(spawnClone).mockClear();
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const result = await handlers.sprout({ task: "investigate X", wait_mode: "async" });
    expect(result).toEqual({ status: "async_not_supported" });
    expect(spawnClone).not.toHaveBeenCalled();
  });

  it("forks a clone and records the real transcript length as branchLength on success", async () => {
    vi.mocked(spawnClone).mockClear();
    const { appendAuditEntry } = await import("mekiri-core");
    vi.mocked(appendAuditEntry).mockClear();

    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const result = await handlers.sprout({ task: "investigate X" });

    expect(result).toEqual({ status: "ok", child_session_id: "child-1", result: "done" });
    expect(spawnClone).toHaveBeenCalledTimes(1);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditEntry).mock.calls[0][1] as { branchLength: number };
    expect(entry.branchLength).toBe(JSON.stringify(FIXTURE_TRANSCRIPT).length);
    expect(entry.branchLength).toBeGreaterThan(0);
  });
});

describe("tag handler", () => {
  it("records a portal fruit with files_touched and returns rule_id", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.tag({
      quote: "the answer is 42",
      fruit: {
        summary: "tagged the current state before a risky refactor",
        files_touched: [{ path: "src/foo.ts", change: "modified" }],
      },
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(typeof result.rule_id).toBe("string");

    const { readCapsule, findCapsuleEntry, readReportRange } = await import("mekiri-core");
    const capsule = await readCapsule(projectDir, "s1");
    expect(capsule).toContain(result.rule_id);
    expect(capsule).toContain("tagged the current state before a risky refactor");

    const entry = await findCapsuleEntry(projectDir, result.rule_id);
    expect(entry).toBeDefined();
    expect(entry?.event).toBe("tag");

    const body = await readReportRange(projectDir, entry!.sessionId, entry!.startLine, entry!.endLine);
    expect(body).toContain("tagged the current state before a risky refactor");
  });

  it("never posts a rewrite rule -- marks the range without cutting it", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule });

    const result = await handlers.tag({
      quote: "the answer is 42",
      fruit: { summary: "important block, not to be cut", files_touched: [{ path: "src/foo.ts", change: "modified" }] },
    });

    expect(result.status).toBe("ok");
    expect(postControlRule).not.toHaveBeenCalled();
  });

  it("records markedLength as the size of the transcript slice up to the quote", async () => {
    const { appendAuditEntry } = await import("mekiri-core");
    vi.mocked(appendAuditEntry).mockClear();
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    await handlers.tag({
      quote: "the answer is 42",
      fruit: { summary: "marked range", files_touched: [{ path: "src/foo.ts", change: "modified" }] },
    });

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditEntry).mock.calls[0][1] as { markedLength: number };
    expect(entry.markedLength).toBe(JSON.stringify(FIXTURE_TRANSCRIPT).length);
  });

  it("returns not_found when the quote doesn't match anything in the transcript", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.tag({
      quote: "this text does not appear anywhere in the fixture transcript",
      fruit: { summary: "should not be recorded", files_touched: [{ path: "src/foo.ts", change: "modified" }] },
    });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns invalid_fruit when files_touched is omitted (keep_code is always true for tag)", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.tag({ quote: "the answer is 42", fruit: { summary: "no files touched here" } });

    expect(result.status).toBe("invalid_fruit");
    if (result.status !== "invalid_fruit") throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("graft handler", () => {
  it("returns the full capsule as a table of contents when no target is given", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    await handlers.tag({
      quote: "the answer is 42",
      fruit: { summary: "first tagged snapshot", files_touched: [{ path: "a.ts", change: "modified" }] },
    });
    await handlers.tag({
      quote: "the answer is 42",
      fruit: { summary: "second tagged snapshot", files_touched: [{ path: "b.ts", change: "added" }] },
    });

    const result = await handlers.graft({});

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("toc");
    expect(result.content).toContain("first tagged snapshot");
    expect(result.content).toContain("second tagged snapshot");
  });

  it("returns the full wrapped body for a known target rule_id", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const tagged = await handlers.tag({
      quote: "the answer is 42",
      fruit: { summary: "graftable snapshot content", files_touched: [{ path: "a.ts", change: "modified" }] },
    });
    if (tagged.status !== "ok") throw new Error("unreachable");

    const result = await handlers.graft({ target: tagged.rule_id });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("full");
    expect(result.content).toContain(`[graft: tag ${tagged.rule_id}, session s1,`);
    expect(result.content).toContain("graftable snapshot content");
  });

  it("returns not_found for an unknown target", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.graft({ target: "nonexistent" });

    expect(result).toEqual({ status: "not_found" });
  });

  it("can graft a prune's distillate back, proving prune now writes to the report store too", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const pruned = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "pruned branch about the answer" },
      keep_code: false,
    });
    if (pruned.status !== "ok") throw new Error("unreachable");

    const result = await handlers.graft({ target: pruned.rule_id });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("full");
    expect(result.content).toContain(`[graft: prune ${pruned.rule_id}, session s1,`);
    expect(result.content).toContain(pruned.distillate);
  });

  it("scopes the no-target toc to the calling session, but still resolves another session's rule_id by target", async () => {
    const handlersS1 = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const handlersS2 = createToolHandlers({ sessionId: "s2", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const taggedByS1 = await handlersS1.tag({
      quote: "the answer is 42",
      fruit: { summary: "snapshot tagged from session s1", files_touched: [{ path: "a.ts", change: "modified" }] },
    });
    if (taggedByS1.status !== "ok") throw new Error("unreachable");

    const s2Toc = await handlersS2.graft({});
    expect(s2Toc.status).toBe("ok");
    if (s2Toc.status !== "ok") throw new Error("unreachable");
    expect(s2Toc.mode).toBe("toc");
    expect(s2Toc.content).not.toContain("snapshot tagged from session s1");

    const s1Toc = await handlersS1.graft({});
    if (s1Toc.status !== "ok") throw new Error("unreachable");
    expect(s1Toc.content).toContain("snapshot tagged from session s1");

    const crossSessionGraft = await handlersS2.graft({ target: taggedByS1.rule_id });
    expect(crossSessionGraft.status).toBe("ok");
    if (crossSessionGraft.status !== "ok") throw new Error("unreachable");
    expect(crossSessionGraft.mode).toBe("full");
    expect(crossSessionGraft.content).toContain("snapshot tagged from session s1");
    expect(crossSessionGraft.content).toContain(`session s1`);
  });
});
