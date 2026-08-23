import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolHandlers } from "../src/mcpServer.js";
import { spawnClone } from "../src/spawnClone.js";
import type { AuditEntry } from "mekiri-core";

// appendAuditEntry is mocked to a no-op above, so handler calls in these
// tests never actually write to disk -- metrics tests that need real
// audit.jsonl history append it directly with this helper instead, bypassing
// the mock the same way a real prior session audit log would exist.
async function writeAuditEntries(dir: string, entries: AuditEntry[]): Promise<void> {
  const filePath = path.join(dir, ".mekiri", "audit.jsonl");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, entries.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
}

const FIXTURE_TRANSCRIPT = [
  { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "the answer is 42" }] } },
];

vi.mock("mekiri-core", async () => {
  const actual = await vi.importActual<typeof import("mekiri-core")>("mekiri-core");
  return {
    ...actual,
    readSessionTranscript: vi.fn(async () => FIXTURE_TRANSCRIPT),
    readSessionTranscriptOrNull: vi.fn(async () => FIXTURE_TRANSCRIPT),
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
// like the pre-existing tests old "/proj" fixture would.
let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "mekiri-mcpserver-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("prune handler: cutting calls (quote non-empty)", () => {
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
      fruit: { summary: "found the answer", kept_context: "" },
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
      fruit: { summary: "first", kept_context: "" },
      keep_code: false,
    });
    const second = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "second", kept_context: "" },
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

  it("flags a files_touched path as unverified when no matching Write/Edit tool_use is in the cut range", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "translated the file", files_touched: [{ path: "README.md", change: "translated to English" }], kept_context: "" },
      keep_code: true,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.unverified_files).toEqual(["README.md"]);

    const { appendAuditEntry } = await import("mekiri-core");
    const entry = vi.mocked(appendAuditEntry).mock.calls.at(-1)![1] as { unverifiedFiles?: string[] };
    expect(entry.unverifiedFiles).toEqual(["README.md"]);
  });

  it("does not flag a files_touched path backed by a real Write tool_use in the cut range", async () => {
    const { readSessionTranscript } = await import("mekiri-core");
    vi.mocked(readSessionTranscript).mockResolvedValueOnce([
      { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "the answer is 42" }] } },
      {
        type: "assistant",
        uuid: "a2",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/home/pol/dev/rollback/README.md" } } as never],
        },
      },
    ]);
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "translated the file", files_touched: [{ path: "README.md", change: "translated to English" }], kept_context: "" },
      keep_code: true,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.unverified_files).toBeUndefined();
  });

  it("does not annotate unverified_files for death_reload fruit (no files_touched field to check)", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "the answer is 42",
      note_type: "death_reload",
      fruit: { tried: "assumed a race condition", ruled_out: "not a race condition", kept_context: "" },
      keep_code: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.unverified_files).toBeUndefined();
  });
});

describe("sprout handler", () => {
  it("returns depth_limit_exceeded when own depth is at the configured limit", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 1, daemonPort: 8791, postControlRule: vi.fn() });
    // default config sprout.depth_limit is 1 (see mekiri-core defaultConfig) -- depth 1 means already at the ceiling
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

describe("prune handler: pure archive calls (quote empty)", () => {
  it("records a kept_context fruit and returns rule_id, without resolving any transcript boundary", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: {
        summary: "",
        kept_context: "important state before a risky refactor",
        files_touched: [{ path: "src/foo.ts", change: "modified" }],
      },
      keep_code: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(typeof result.rule_id).toBe("string");

    const { readCapsule, findCapsuleEntry, readReportRange } = await import("mekiri-core");
    const capsule = await readCapsule(projectDir, "s1");
    expect(capsule).toContain(result.rule_id);
    expect(capsule).toContain("important state before a risky refactor");

    const entry = await findCapsuleEntry(projectDir, result.rule_id);
    expect(entry).toBeDefined();
    expect(entry?.event).toBe("prune");
    expect(entry?.parts).toEqual(["kept"]);

    const body = await readReportRange(projectDir, entry!.sessionId, entry!.startLine, entry!.endLine);
    expect(body).toContain("important state before a risky refactor");
  });

  it("never posts a rewrite rule, since there is nothing to cut", async () => {
    const postControlRule = vi.fn(async () => {});
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule });

    const result = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "important block, not to be cut" },
      keep_code: false,
    });

    expect(result.status).toBe("ok");
    expect(postControlRule).not.toHaveBeenCalled();
  });

  it("records markedLength as the length of kept_context itself, not any transcript slice", async () => {
    const { appendAuditEntry } = await import("mekiri-core");
    vi.mocked(appendAuditEntry).mockClear();
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const keptContext = "marked range";
    await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: keptContext },
      keep_code: false,
    });

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditEntry).mock.calls[0][1] as { markedLength: number };
    expect(entry.markedLength).toBe(keptContext.length);
  });

  it("returns invalid_fruit when both quote and kept_context are empty (nothing to cut, nothing to keep)", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "" },
      keep_code: false,
    });

    expect(result.status).toBe("invalid_fruit");
    if (result.status !== "invalid_fruit") throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("does not require files_touched even when keep_code is true, since keep_code only applies to the cut side", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "no files touched here, still a valid archive call" },
      keep_code: true,
    });

    expect(result.status).toBe("ok");
  });

  it("never computes unverified_files for an archive-only call, even when files_touched is given", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: {
        summary: "",
        kept_context: "important block",
        files_touched: [{ path: "src/foo.ts", change: "modified" }],
      },
      keep_code: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.unverified_files).toBeUndefined();
  });
});

describe("graft handler", () => {
  it("returns the full capsule as a table of contents when no target is given", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "first tagged snapshot", files_touched: [{ path: "a.ts", change: "modified" }] },
      keep_code: false,
    });
    await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "second tagged snapshot", files_touched: [{ path: "b.ts", change: "added" }] },
      keep_code: false,
    });

    const result = await handlers.graft({});

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("toc");
    expect(result.content).toContain("first tagged snapshot");
    expect(result.content).toContain("second tagged snapshot");
  });

  it("returns the raw transcript fragment (not the distillate) for a known target rule_id", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const tagged = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "graftable snapshot content", files_touched: [{ path: "a.ts", change: "modified" }] },
      keep_code: false,
    });
    if (tagged.status !== "ok") throw new Error("unreachable");

    const result = await handlers.graft({ target: tagged.rule_id });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("raw");
    expect(result.content).toContain("[graft: prune " + tagged.rule_id + ", session s1,");
    // Raw content is the real transcript (FIXTURE_TRANSCRIPT), not the
    // agent-authored kept_context string -- that's the whole point of the fix.
    expect(result.content).toContain("the answer is 42");
    expect(result.content).not.toContain("graftable snapshot content");
  });

  it("returns not_found for an unknown target", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.graft({ target: "nonexistent" });

    expect(result).toEqual({ status: "not_found" });
  });

  it("can graft a cutting prune's raw fragment back too, proving both call shapes land in the same index", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const pruned = await handlers.prune({
      quote: "the answer is 42",
      note_type: "portal",
      fruit: { summary: "pruned branch about the answer", kept_context: "" },
      keep_code: false,
    });
    if (pruned.status !== "ok") throw new Error("unreachable");

    const result = await handlers.graft({ target: pruned.rule_id });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("raw");
    expect(result.content).toContain("[graft: prune " + pruned.rule_id + ", session s1,");
    // Raw range covers up to (and including) the cut boundary in the real
    // transcript -- not the agent-authored distillate summary.
    expect(result.content).toContain("the answer is 42");
    expect(result.content).not.toContain(pruned.distillate);
  });

  it("scopes the no-target toc to the calling session, but still resolves another session rule_id by target", async () => {
    const handlersS1 = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const handlersS2 = createToolHandlers({ sessionId: "s2", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const taggedByS1 = await handlersS1.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "snapshot tagged from session s1", files_touched: [{ path: "a.ts", change: "modified" }] },
      keep_code: false,
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
    expect(crossSessionGraft.mode).toBe("raw");
    expect(crossSessionGraft.content).toContain("the answer is 42");
    expect(crossSessionGraft.content).toContain("session s1");
  });

  it("returns no_raw_range for an entry written before raw-range recording existed, without crashing or silently falling back to the distillate", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    // Simulate a capsule-index.jsonl entry from before this feature existed --
    // no rawStartLine/rawEndLine at all -- by writing the report/index files
    // directly rather than going through prune().
    const { recordDistillate } = await import("mekiri-core");
    await recordDistillate(
      projectDir,
      { event: "prune", sessionId: "s1", ruleId: "legacy-rule", noteType: "portal", timestamp: "2026-01-01T00:00:00.000Z", parts: ["kept"] },
      "legacy header",
      "legacy body",
    );

    const result = await handlers.graft({ target: "legacy-rule" });

    expect(result).toEqual({ status: "no_raw_range" });
  });

  it("returns transcript_unavailable (not a crash, not the distillate) when the raw transcript file is missing", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const tagged = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "snapshot with a since-vanished transcript" },
      keep_code: false,
    });
    if (tagged.status !== "ok") throw new Error("unreachable");

    const { readSessionTranscriptOrNull } = await import("mekiri-core");
    vi.mocked(readSessionTranscriptOrNull).mockResolvedValueOnce(null);

    const result = await handlers.graft({ target: tagged.rule_id });

    expect(result).toEqual({ status: "transcript_unavailable" });
  });

  it("truncates raw content over the size limit and flags it, still reporting the real length", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const hugeTranscript = Array.from({ length: 500 }, (_, i) => ({
      type: "assistant",
      uuid: `a${i}`,
      message: { role: "assistant", content: [{ type: "text", text: `line ${i} `.repeat(20) }] },
    }));
    const { readSessionTranscriptOrNull } = await import("mekiri-core");
    vi.mocked(readSessionTranscriptOrNull).mockResolvedValueOnce(hugeTranscript);

    const tagged = await handlers.prune({
      quote: "",
      note_type: "portal",
      fruit: { summary: "", kept_context: "huge snapshot" },
      keep_code: false,
    });
    if (tagged.status !== "ok") throw new Error("unreachable");

    vi.mocked(readSessionTranscriptOrNull).mockResolvedValueOnce(hugeTranscript);
    const result = await handlers.graft({ target: tagged.rule_id });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.mode).toBe("raw");
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(result.length);
    expect(result.content).toContain("truncated");
  });
});

describe("metrics handler", () => {
  it("returns not_found for the default session scope when the project has no audit history yet", async () => {
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.metrics({});

    expect(result).toEqual({ status: "not_found" });
  });

  it("scopes to the calling session own tree by default, and not_found for a session with no history", async () => {
    await writeAuditEntries(projectDir, [
      { event: "prune", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s1", ruleId: "r1", noteType: "portal", parts: ["cut"], removedBranchLength: 500, fruitLength: 50 },
    ]);
    const handlersS1 = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });
    const handlersOther = createToolHandlers({ sessionId: "other", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlersS1.metrics({});
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.scope !== "session") throw new Error("unreachable");
    expect(result.report.rootSessionId).toBe("s1");
    expect(result.report.pruneCount).toBe(1);
    expect(result.report.sproutCount).toBe(0);

    expect(await handlersOther.metrics({})).toEqual({ status: "not_found" });
  });

  it("returns every session tree in the project for scope equal to project", async () => {
    await writeAuditEntries(projectDir, [
      { event: "prune", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s1", ruleId: "r1", noteType: "portal", parts: ["cut"], removedBranchLength: 500, fruitLength: 50 },
      { event: "sprout", timestamp: "2026-01-01T00:01:00.000Z", sessionId: "s2", childSessionId: "s2-child", branchLength: 300, harvestLength: 30 },
    ]);
    const handlers = createToolHandlers({ sessionId: "s1", dir: projectDir, depth: 0, daemonPort: 8791, postControlRule: vi.fn() });

    const result = await handlers.metrics({ scope: "project" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.scope !== "project") throw new Error("unreachable");
    expect(result.report.trees.map((t) => t.rootSessionId).sort()).toEqual(["s1", "s2"]);
  });
});
