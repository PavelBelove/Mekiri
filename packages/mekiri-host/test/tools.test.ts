import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handlePrune,
  handleHarvest,
  handleSprout,
  handleConfigure,
  resolveParallelismLimit,
  formatAsyncSproutSuccess,
  formatAsyncSproutError,
} from "../src/tools.js";
import type { HarvestArgs, SproutArgs, ConfigureArgs } from "../src/tools.js";
import type { RawLine } from "mekiri-core";
import { readAuditLog, loadConfig, defaultConfig, createClaudeCodeBackend } from "mekiri-core";
import { sanitizeDir, writeSessionFile, copyRealCredentials } from "./helpers/sessionFile.js";
import { createAsyncSproutLimiter } from "../src/asyncSproutLimiter.js";

const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const U1_UUID = "77777777-7777-4777-8777-777777777777";
const A1_UUID = "88888888-8888-4888-8888-888888888888";
const A2_UUID = "99999999-9999-4999-8999-999999999999";

describe("handlePrune", () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let switchCalls: Array<{ newSessionId: string; injectText: string }>;
  let transcriptLines: RawLine[];

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    switchCalls = [];

    transcriptLines = [
      { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Reading the logs now, this is the boundary." }] } },
      { type: "assistant", uuid: A2_UUID, parentUuid: A1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "More garbage after the boundary." }] } },
    ];
    await writeSessionFile(configDir, projectDir, SESSION_ID, transcriptLines);
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeContext() {
    return {
      dir: projectDir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId: string, injectText: string) => {
        switchCalls.push({ newSessionId, injectText });
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from a prune-only test");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };
  }

  it("prunes successfully, calls onSwitch with a new session id, and reports ok", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: { summary: "Found the cause, fixed it.", files_touched: [{ path: "src/foo.ts", change: "fix" }] },
      keep_code: true,
    });

    expect(result.isError).toBeFalsy();
    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).not.toBe(SESSION_ID);
    expect(switchCalls[0].injectText).toContain("Found the cause, fixed it.");
  });

  it("returns an error result and does not call onSwitch when fruit validation fails", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "Reading the logs now, this is the boundary",
      note_type: "portal",
      fruit: {}, // missing required summary
      keep_code: true,
    });

    expect(result.isError).toBe(true);
    expect(switchCalls).toHaveLength(0);
  });

  it("reports not_found and does not call onSwitch when the quote doesn't match", async () => {
    const result = await handlePrune(makeContext(), {
      quote: "this text does not appear anywhere in the transcript",
      note_type: "portal",
      fruit: { summary: "irrelevant" },
      keep_code: false,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("not_found");
    expect(switchCalls).toHaveLength(0);
  });
});

describe("handleHarvest", () => {
  function makeClonelikeContext(onHarvest: (result: string, needsCleanLook: boolean) => void) {
    return {
      dir: "/irrelevant/for/this/test",
      depth: 1,
      isClone: true,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000099",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest,
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };
  }

  function makeParentContext() {
    return {
      dir: "/irrelevant/for/this/test",
      depth: 0,
      isClone: false,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000098",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {
        throw new Error("onHarvest should never be called when isClone is false");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };
  }

  it("calls onHarvest with the result and needsCleanLook when isClone is true", async () => {
    let captured: { result: string; needsCleanLook: boolean } | null = null;
    const context = makeClonelikeContext((result, needsCleanLook) => {
      captured = { result, needsCleanLook };
    });

    const args: HarvestArgs = { result: "the distilled answer", needs_clean_look: true };
    const output = await handleHarvest(context, args);

    expect(output.isError).toBeFalsy();
    expect(captured).toEqual({ result: "the distilled answer", needsCleanLook: true });
  });

  it("defaults needsCleanLook to false when needs_clean_look is omitted", async () => {
    let captured: { result: string; needsCleanLook: boolean } | null = null;
    const context = makeClonelikeContext((result, needsCleanLook) => {
      captured = { result, needsCleanLook };
    });

    await handleHarvest(context, { result: "ok" });

    expect(captured).toEqual({ result: "ok", needsCleanLook: false });
  });

  it("returns an error result and never calls onHarvest when isClone is false", async () => {
    const context = makeParentContext();

    const output = await handleHarvest(context, { result: "should not apply" });

    expect(output.isError).toBe(true);
    expect(JSON.stringify(output.content)).toContain("harvest валиден только внутри sprout-клона");
  });
});

// handleSprout makes real, billed API calls (it drives a full runClone()
// internally). Kept to the minimum needed to prove the mechanics per the
// project's live-test-budget policy.
describe("handleSprout", () => {
  let sproutConfigDir: string;
  let sproutProjectDir: string;
  let sproutOriginalConfigDir: string | undefined;

  beforeEach(async () => {
    sproutConfigDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-config-"));
    sproutProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-project-"));
    sproutOriginalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sproutConfigDir;
  });

  afterEach(async () => {
    if (sproutOriginalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = sproutOriginalConfigDir;
    await rm(sproutConfigDir, { recursive: true, force: true });
    await rm(sproutProjectDir, { recursive: true, force: true });
  });

  it("returns depth_limit_exceeded without forking when the child depth exceeds the default limit", async () => {
    // Default depth_limit is 1 (mekiri-core's defaultConfig, no .mekiri/config.json
    // written in this test project dir), so a context already at depth 1 must
    // refuse to sprout a depth-2 child.
    const context = {
      dir: sproutProjectDir,
      depth: 1,
      isClone: true,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000097",
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {},
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };

    const output = await handleSprout(context, { task: "irrelevant, should be refused before starting" });

    expect(output.isError).toBeFalsy();
    expect(JSON.stringify(output.content)).toContain("depth_limit_exceeded");
  });

  it("forks a real child, runs it to a real harvest, and records a sprout audit entry with real lengths", async () => {
    // Seed a minimal real session file for handleSprout's context.getSessionId()
    // to fork from, following the same UUID-format-id + CLAUDE_CONFIG_DIR/dir
    // convention established in mekiri-core's own branch.test.ts.
    const { promises: fs } = await import("node:fs");

    // This test makes a REAL live query() call (handleSprout -> runClone),
    // which needs real auth credentials copied into the isolated
    // CLAUDE_CONFIG_DIR -- see copyRealCredentials's own doc comment for why.
    await copyRealCredentials(sproutConfigDir);

    const parentSessionId = "bbbbbbbb-0000-4000-8000-000000000001";
    const sessionFilePath = path.join(sproutConfigDir, "projects", sanitizeDir(sproutProjectDir), `${parentSessionId}.jsonl`);
    await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
    await fs.writeFile(
      sessionFilePath,
      `${JSON.stringify({
        type: "user",
        uuid: "cccccccc-0000-4000-8000-000000000001",
        parentUuid: null,
        isSidechain: false,
        message: { role: "user", content: "hello" },
      })}\n`,
      "utf8",
    );

    const context = {
      dir: sproutProjectDir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => parentSessionId,
      getTranscript: () => [],
      onSwitch: () => {},
      onHarvest: () => {},
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };

    const args: SproutArgs = {
      task: "Call the mcp__mekiri__harvest tool right now with result set to exactly the string SPROUT_TEST_RESULT. Do not say anything else first.",
    };
    const output = await handleSprout(context, args);

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.child_session_id).not.toBe(parentSessionId);
    expect(parsed.result).toBe("SPROUT_TEST_RESULT");
    expect(parsed.harvested_implicitly).toBeUndefined();

    const log = await readAuditLog(sproutProjectDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("sprout");
    if (log[0].event === "sprout") {
      expect(log[0].sessionId).toBe(parentSessionId);
      expect(log[0].childSessionId).toBe(parsed.child_session_id);
      expect(log[0].branchLength).toBeGreaterThan(0);
      expect(log[0].harvestLength).toBe(JSON.stringify("SPROUT_TEST_RESULT").length);
    }
  }, 60_000);
});

describe("resolveParallelismLimit", () => {
  it("returns 1 for mode:'single'", () => {
    expect(resolveParallelismLimit({ mode: "single" })).toBe(1);
  });

  it("returns count for mode:'parallel'", () => {
    expect(resolveParallelismLimit({ mode: "parallel", count: 3 })).toBe(3);
  });
});

describe("formatAsyncSproutSuccess / formatAsyncSproutError", () => {
  it("formats a success message with the child session id and result", () => {
    const text = formatAsyncSproutSuccess("child-123", "the distilled result");
    expect(text).toContain("child-123");
    expect(text).toContain("the distilled result");
    expect(text).toContain("branch_type:sprout");
  });

  it("formats an error message with the child session id and error detail", () => {
    const text = formatAsyncSproutError("child-456", new Error("network blip"));
    expect(text).toContain("child-456");
    expect(text).toContain("network blip");
  });

  it("falls back to String() for non-Error throws in the error formatter", () => {
    const text = formatAsyncSproutError("child-789", "raw string failure");
    expect(text).toContain("raw string failure");
  });
});

describe("handleSprout: async wait_mode rejections", () => {
  it("rejects wait_mode:'async' when called from inside a clone", async () => {
    // depth is 0 here (not 1) so that this context stays within the default
    // sprout.depth_limit of 1 (loadConfig on a non-existent dir falls back
    // to defaultConfig()) -- childDepth = depth + 1 must not exceed the
    // limit, otherwise handleSprout's depth check fires first and this test
    // would observe "depth_limit_exceeded" instead of the async-in-clone
    // rejection it's actually targeting. isClone:true is what matters for
    // this test, independent of depth.
    const context = {
      dir: "/tmp/does-not-matter",
      depth: 0,
      isClone: true,
      getSessionId: () => "session-id",
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("onSwitch should not be called");
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called");
      },
    };

    const result = await handleSprout(context, { task: "irrelevant", wait_mode: "async" });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe("async_not_supported_in_clone");
  });

  it("rejects when the parallelism limit is already reached", async () => {
    const limiter = createAsyncSproutLimiter();
    expect(limiter.tryAcquire(1)).toBe(true);

    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sprout-limit-"));
    try {
      const context = {
        dir: projectDir,
        depth: 0,
        isClone: false,
        getSessionId: () => "session-id",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("onSwitch should not be called");
        },
        onHarvest: () => {
          throw new Error("onHarvest should not be called");
        },
        asyncSproutLimiter: limiter,
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called");
        },
      };

      const result = await handleSprout(context, { task: "irrelevant", wait_mode: "async" });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe("parallelism_limit_exceeded");
      expect(parsed.active).toBe(1);
      expect(parsed.limit).toBe(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("handleConfigure", () => {
  let configureProjectDir: string;

  beforeEach(async () => {
    configureProjectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-configure-project-"));
  });

  afterEach(async () => {
    await rm(configureProjectDir, { recursive: true, force: true });
  });

  function makeContext() {
    return {
      dir: configureProjectDir,
      depth: 0,
      isClone: false,
      getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000096",
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("onSwitch should not be called from a configure test");
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from a configure test");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    };
  }

  it("applies a valid patch, persists it to disk, and records an audit entry", async () => {
    const args: ConfigureArgs = { patch: { sprout: { depth_limit: 2 } }, reason: "widen depth for this task" };

    const output = await handleConfigure(makeContext(), args);

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.config.sprout.depth_limit).toBe(2);

    const persisted = await loadConfig(configureProjectDir);
    expect(persisted.sprout.depth_limit).toBe(2);

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe("configure_mekiri");
    if (log[0].event === "configure_mekiri") {
      expect(log[0].reason).toBe("widen depth for this task");
      expect(log[0].patch).toEqual({ sprout: { depth_limit: 2 } });
    }
  });

  it("returns an error result, does not persist, and does not record an audit entry when the patch is invalid", async () => {
    const args: ConfigureArgs = { patch: { sprout: { depth_limit: -1 } }, reason: "should be rejected" };

    const output = await handleConfigure(makeContext(), args);

    expect(output.isError).toBe(true);

    const persisted = await loadConfig(configureProjectDir);
    expect(persisted).toEqual(defaultConfig());

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(0);
  });

  it("deep-merges a patch, leaving unrelated fields untouched", async () => {
    await handleConfigure(makeContext(), { patch: { sprout: { depth_limit: 3 } }, reason: "first change" });

    const output = await handleConfigure(makeContext(), {
      patch: { priorities: { token_efficiency: "aggressive" } },
      reason: "second change",
    });

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.config.priorities.token_efficiency).toBe("aggressive");
    expect(parsed.config.sprout.depth_limit).toBe(3);

    const log = await readAuditLog(configureProjectDir);
    expect(log).toHaveLength(2);
  });
});
