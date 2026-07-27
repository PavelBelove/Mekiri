import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { UserPromptSubmitHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createInputQueue } from "../src/inputQueue.js";
import { createMekiriTools, handleSprout } from "../src/tools.js";
import { createAsyncSproutLimiter } from "../src/asyncSproutLimiter.js";
import { canUseTool, buildQueryOptions, formatQueryErrorMessage, MEKIRI_SYSTEM_PROMPT } from "../src/permissions.js";
import { writeSessionFile, copyRealCredentials } from "./helpers/sessionFile.js";
import { loadConfig, readAuditLog, createClaudeCodeBackend } from "mekiri-core";
import type { RawLine } from "mekiri-core";

// These tests make real, billed API calls. Keep them to the minimum needed
// to prove the wiring this task adds actually works end to end — everything
// beyond this is manual dogfooding per the design spec's explicit choice.
describe("mekiri-host live smoke test", () => {
  it("completes one real turn, captures a session id, and receives assistant text", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let sessionId: string | undefined;
    let sawAssistantText = false;

    const q = query({ prompt: iterable, options: { cwd: process.cwd() } });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantText).toBe(true);
  }, 60_000);

  it("resumes a session by id and the resumed query's init message reports the same session id", async () => {
    const first = createInputQueue();
    first.push("Reply with exactly one word: ok");
    first.close();

    let firstSessionId: string | undefined;
    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") firstSessionId = message.session_id;
    }
    expect(firstSessionId).toBeTruthy();

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    const q2 = query({ prompt: second.iterable, options: { resume: firstSessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") secondSessionId = message.session_id;
    }

    expect(secondSessionId).toBe(firstSessionId);
  }, 60_000);

  it("mid-turn: calling q.return() after the first assistant message, then resuming, picks up the same session cleanly", async () => {
    const first = createInputQueue();
    first.push("Count from 1 to 10, one number per line.");
    first.close();

    let sessionId: string | undefined;
    let sawAssistantMessage = false;

    const q1 = query({ prompt: first.iterable, options: { cwd: process.cwd() } });
    for await (const message of q1) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }

      if (message.type === "assistant") {
        sawAssistantMessage = true;
      }

      // Mirrors repl.ts's actual pendingSwitch path: interrupt mid-turn as
      // soon as we've seen a real assistant message, rather than letting the
      // generator exhaust naturally.
      if (sawAssistantMessage) {
        await q1.return(undefined);
        break;
      }
    }

    expect(sessionId).toBeTruthy();
    expect(sawAssistantMessage).toBe(true);

    const second = createInputQueue();
    second.push("Reply with exactly one word: ok");
    second.close();

    let secondSessionId: string | undefined;
    let sawAssistantText = false;

    const q2 = query({ prompt: second.iterable, options: { resume: sessionId, cwd: process.cwd() } });
    for await (const message of q2) {
      if (message.type === "system" && message.subtype === "init") {
        secondSessionId = message.session_id;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            sawAssistantText = true;
          }
        }
      }
    }

    expect(secondSessionId).toBe(sessionId);
    expect(sawAssistantText).toBe(true);
  }, 60_000);
});

// Unit-style (no live API call needed): the bug fixed here was in
// canUseTool's *return value* for non-mekiri tools, not in live SDK
// behavior, so a direct call is the cheapest deterministic way to prove it.
// Previously this branch returned `null`, which the SDK's own contract
// documents as fail-closed ("an accidental null means no control_response
// is sent and the tool stays blocked indefinitely") — i.e. a silent hang
// with no visible prompt at all. It must now return an explicit `deny` so
// the model sees a fast, honest failure instead.
describe("canUseTool: non-mekiri tools", () => {
  const dummyCallOptions = {
    signal: new AbortController().signal,
    toolUseID: "test-tool-use-id",
    requestId: "test-request-id",
  };

  it("returns an explicit deny (never null) for a tool outside the mcp__mekiri__ prefix", async () => {
    const result = await canUseTool("Bash", { command: "echo hi" }, dummyCallOptions);
    expect(result).not.toBeNull();
    expect(result).toEqual({ behavior: "deny", message: expect.any(String) });
  });

  it("still allows mcp__mekiri__ tools", async () => {
    const result = await canUseTool("mcp__mekiri__prune", {}, dummyCallOptions);
    expect(result).toEqual({ behavior: "allow" });
  });
});

// Closes the gap where a prior regression test reconstructed its own
// query() call instead of exercising runRepl()'s actual code path: this
// asserts that the exact options object runRepl() passes to query() (via
// the shared buildQueryOptions helper) wires canUseTool in, so a future
// change that stops wiring it into runRepl() specifically (not just the
// standalone canUseTool export) would be caught.
describe("buildQueryOptions", () => {
  it("wires the fixed canUseTool into the options object runRepl() passes to query()", () => {
    const options = buildQueryOptions({
      resume: undefined,
      cwd: "/tmp/does-not-matter",
      mcpServers: { mekiri: {} as never },
    });
    expect(options.canUseTool).toBe(canUseTool);
  });

  it("wires the mekiri skills-plugin into the options object", () => {
    const options = buildQueryOptions({
      resume: undefined,
      cwd: "/tmp/does-not-matter",
      mcpServers: { mekiri: {} as never },
    });
    expect(options.plugins).toEqual([{ type: "local", path: expect.stringContaining("skills-plugin") }]);
  });

  it("wires the Mekiri system prompt into the options object", () => {
    const options = buildQueryOptions({
      resume: undefined,
      cwd: "/tmp/does-not-matter",
      mcpServers: { mekiri: {} as never },
    });
    expect(options.systemPrompt).toBe(MEKIRI_SYSTEM_PROMPT);
  });

  it("wires a UserPromptSubmit hook that surfaces the mekiri-tuning signal from the real audit log at cwd, once", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-hook-wiring-"));
    try {
      await mkdir(path.join(projectDir, ".mekiri"), { recursive: true });
      const lowRatioEntry = { event: "prune", timestamp: "2026-07-26T00:00:00.000Z", sessionId: "s1", newSessionId: "s2", noteType: "portal", removedBranchLength: 100, fruitLength: 80 };
      const lines = [lowRatioEntry, lowRatioEntry, lowRatioEntry].map((entry) => JSON.stringify(entry)).join("\n");
      await writeFile(path.join(projectDir, ".mekiri", "audit.jsonl"), `${lines}\n`, "utf8");

      const options = buildQueryOptions({
        resume: undefined,
        cwd: projectDir,
        mcpServers: { mekiri: {} as never },
      });

      expect(options.hooks?.UserPromptSubmit).toHaveLength(1);
      const hook = options.hooks?.UserPromptSubmit?.[0].hooks[0];
      expect(hook).toBeTypeOf("function");

      const dummyInput = {} as UserPromptSubmitHookInput;
      const dummyOptions = { signal: new AbortController().signal };

      const firstOutput = await hook!(dummyInput, undefined, dummyOptions);
      expect(firstOutput).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: expect.stringContaining("Distillation Ratio"),
        },
      });

      const secondOutput = await hook!(dummyInput, undefined, dummyOptions);
      expect(secondOutput).toEqual({});
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// A real query()/stream failure (auth expiry, rate limit, network blip) is
// hard to reproduce deterministically and not worth a live API call to
// force, so this tests the extracted pure formatter instead — the piece of
// runRepl()'s error-handling that actually decides what the user is told.
// The surrounding try/catch + `continue` control flow in runRepl() (which
// keeps currentSessionId set and re-enters the while loop instead of
// letting the error propagate and crash the process) is covered by manual
// code review plus the live smoke tests above, which exercise the same
// for-await loop machinery on the happy path.
describe("formatQueryErrorMessage", () => {
  it("includes the error's message and tells the user how to keep going", () => {
    const message = formatQueryErrorMessage(new Error("rate limited"));
    expect(message).toContain("rate limited");
    expect(message).toContain("Type your next message to try resuming this session");
    expect(message).toContain("Ctrl+C to exit");
  });

  it("falls back to String() for non-Error throws", () => {
    const message = formatQueryErrorMessage("network blip");
    expect(message).toContain("network blip");
  });
});

// Regression test for the hang found via manual dogfooding: repl.ts wires
// mcpServers: { mekiri: tools } into query() but, without a canUseTool
// callback, the SDK falls back to interactive permission prompting with no
// UI to answer it — a real `prune` call from the model would hang forever.
// This test runs the exact same mcpServers + canUseTool wiring repl.ts uses
// (importing canUseTool from ../src/repl.js, not reimplementing it) and
// drives the model to actually call the tool, asserting it reaches
// completion (onSwitch fires) instead of hanging.
describe("mekiri-host live smoke test: prune tool permission wiring", () => {
  const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const U1_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const A1_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const A2_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const BOUNDARY_QUOTE = "Reading the logs now, this is the boundary.";

  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let transcriptLines: RawLine[];

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-repl-config-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-repl-project-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await copyRealCredentials(configDir);

    transcriptLines = [
      { type: "user", uuid: U1_UUID, parentUuid: null, isSidechain: false, message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", uuid: A1_UUID, parentUuid: U1_UUID, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: BOUNDARY_QUOTE }] } },
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

  it("a real model turn that calls prune completes (onSwitch fires) instead of hanging on a permission prompt", async () => {
    const switchCalls: Array<{ newSessionId: string; injectText: string }> = [];

    const tools = createMekiriTools({
      dir: projectDir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => SESSION_ID,
      getTranscript: () => transcriptLines,
      onSwitch: (newSessionId, injectText) => {
        switchCalls.push({ newSessionId, injectText });
      },
      onHarvest: () => {
        throw new Error("onHarvest should not be called from a prune-only test");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    });

    const { iterable, push, close } = createInputQueue();
    push(
      [
        "Call the prune tool (mcp__mekiri__prune) right now, in this turn, with exactly these arguments and no others:",
        `quote: "${BOUNDARY_QUOTE}"`,
        'note_type: "portal"',
        'fruit: {"summary": "smoke test prune", "files_touched": []}',
        "keep_code: true",
        "The mcp__mekiri__prune tool is already directly available to you — do not use ToolSearch or any other lookup tool first, and do not call any other tool. Make mcp__mekiri__prune your first and only tool call, immediately. Do not ask for permission or confirmation, and do not explain what you are about to do first — just make the tool call.",
      ].join("\n"),
    );
    close();

    let sawToolResult = false;

    const q = query({
      prompt: iterable,
      options: {
        cwd: projectDir,
        mcpServers: { mekiri: tools },
        canUseTool,
      },
    });

    for await (const message of q) {
      if (message.type === "user") {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
              sawToolResult = true;
            }
          }
        }
      }
    }

    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0].newSessionId).not.toBe(SESSION_ID);
    expect(switchCalls[0].injectText).toContain("smoke test prune");
    expect(sawToolResult).toBe(true);
  }, 60_000);
});

// Real, billed end-to-end proof that sprout/harvest work from the actual
// parent code path (runRepl's own createMekiriTools wiring), not just via
// tools.test.ts's direct handleSprout calls. Deliberately drives handleSprout
// directly with the real createMekiriTools (rather than spinning up a full
// runRepl() with readline, which has no clean way to await from a test) --
// this still exercises the real depth:0/isClone:false parent context shape
// wired in repl.ts, just without the readline/stdin layer runRepl adds on
// top. Uses process.cwd() (the real repo) as dir and does not override
// CLAUDE_CONFIG_DIR, so no credential copying is needed here (same as the
// other live tests in this file's main describe block).
describe("mekiri-host live smoke test: sprout/harvest end-to-end from the parent's real tool wiring", () => {
  it("a clone can prune its own failed hypothesis, then harvest the successful path", async () => {
    const dir = process.cwd();
    let parentSessionId: string | undefined;

    const parentTools = createMekiriTools({
      dir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => {
        if (!parentSessionId) throw new Error("no parent session id yet");
        return parentSessionId;
      },
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("parent should not prune itself in this test");
      },
      onHarvest: () => {
        throw new Error("parent should never receive a harvest call directly");
      },
      asyncSproutLimiter: createAsyncSproutLimiter(),
      onAsyncSproutComplete: () => {
        throw new Error("onAsyncSproutComplete should not be called in this test");
      },
    });

    // Establish a real parent session id the same way repl.ts does: run one
    // trivial turn and read session_id off the system/init message.
    const seed = createInputQueue();
    seed.push("Reply with exactly one word: ok");
    seed.close();
    const seedQuery = query({
      prompt: seed.iterable,
      options: buildQueryOptions({ resume: undefined, cwd: dir, mcpServers: { mekiri: parentTools } }),
    });
    for await (const message of seedQuery) {
      if (message.type === "system" && message.subtype === "init") {
        parentSessionId = message.session_id;
      }
    }
    expect(parentSessionId).toBeTruthy();

    // Now drive a real sprout via the same handleSprout the sprout tool
    // calls, through the real parent context shape.
    const output = await handleSprout(
      {
        dir,
        depth: 0,
        isClone: false,
        backend: createClaudeCodeBackend(),
        getSessionId: () => parentSessionId as string,
        getTranscript: () => [],
        onSwitch: () => {},
        onHarvest: () => {},
        asyncSproutLimiter: createAsyncSproutLimiter(),
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called in this test");
        },
      },
      {
        task:
          "First, state the sentence: Trying hypothesis A now, this is a test. Then immediately call the mcp__mekiri__prune tool with quote set to the verbatim text 'Trying hypothesis A now, this is a test', note_type 'death_reload', fruit set to {\"tried\": \"hypothesis A\", \"ruled_out\": \"A does not apply here, this is a scripted test\"}, and keep_code true. After the prune call returns you will be in a fresh continuation of this same task -- at that point call the mcp__mekiri__harvest tool with result set to exactly the string PRUNE_THEN_HARVEST_OK and nothing else.",
      },
    );

    expect(output.isError).toBeFalsy();
    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.result).toBe("PRUNE_THEN_HARVEST_OK");
  }, 90_000);
});

describe("mekiri-host live smoke test: configure_mekiri tool wiring", () => {
  it("a real model turn that calls configure_mekiri completes and persists the patched config", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-configure-smoke-"));

    try {
      const tools = createMekiriTools({
        dir: projectDir,
        depth: 0,
        isClone: false,
        backend: createClaudeCodeBackend(),
        getSessionId: () => "unused-in-this-test",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("onSwitch should not be called from a configure smoke test");
        },
        onHarvest: () => {
          throw new Error("onHarvest should not be called from a configure smoke test");
        },
        asyncSproutLimiter: createAsyncSproutLimiter(),
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called in this test");
        },
      });

      const { iterable, push, close } = createInputQueue();
      push(
        [
          "Call the configure_mekiri tool (mcp__mekiri__configure_mekiri) right now, in this turn, with exactly these arguments and no others:",
          'patch: {"priorities": {"token_efficiency": "aggressive"}}',
          'reason: "smoke test"',
          "The mcp__mekiri__configure_mekiri tool is already directly available to you -- do not use ToolSearch or any other lookup tool first, and do not call any other tool. Make mcp__mekiri__configure_mekiri your first and only tool call, immediately. Do not ask for permission or confirmation, and do not explain what you are about to do first -- just make the tool call.",
        ].join("\n"),
      );
      close();

      let sawToolResult = false;

      const q = query({
        prompt: iterable,
        options: {
          cwd: projectDir,
          mcpServers: { mekiri: tools },
          canUseTool,
        },
      });

      for await (const message of q) {
        if (message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
                sawToolResult = true;
              }
            }
          }
        }
      }

      expect(sawToolResult).toBe(true);

      const persisted = await loadConfig(projectDir);
      expect(persisted.priorities.token_efficiency).toBe("aggressive");

      const log = await readAuditLog(projectDir);
      expect(log).toHaveLength(1);
      expect(log[0].event).toBe("configure_mekiri");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Real, billed proof that the SDK's own skill discovery actually finds
// mekiri-gate/mekiri-tuning through the bundled local plugin -- this is an
// SDK-internal filesystem walk (SDKSystemMessage.skills), not something a
// unit test can fake. Breaks immediately after the init message; no need to
// pay for a full turn since only skill discovery is under test here.
describe("mekiri-host live smoke test: mekiri-gate/mekiri-tuning skill discovery", () => {
  it("the real SDK discovers both mekiri skills through the bundled local plugin", async () => {
    const { iterable, push, close } = createInputQueue();
    push("Reply with exactly one word: ok");
    close();

    let discoveredSkills: string[] | undefined;

    const q = query({
      prompt: iterable,
      options: buildQueryOptions({ resume: undefined, cwd: process.cwd(), mcpServers: {} }),
    });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        discoveredSkills = message.skills;
        await q.return(undefined);
        break;
      }
    }

    // The SDK's canonical skill id for a plugin-qualified skill is
    // "<pluginName>:<skillName>" (confirmed both by this live run and by
    // sdk.d.ts's own doc comment on Options.skills: "matching the
    // exact canonical name (e.g. \"my-plugin:my-skill\")"). Our plugin's
    // name is "mekiri" (packages/mekiri-host/skills-plugin/.claude-plugin/
    // plugin.json), so the discovered ids are namespaced accordingly rather
    // than the bare skill names.
    expect(discoveredSkills).toContain("mekiri:mekiri-gate");
    expect(discoveredSkills).toContain("mekiri:mekiri-tuning");
  }, 60_000);
});

// Real, billed proof that the system prompt actually steers behavior, not
// just that the field is set (Task 1 already proves wiring). Presents a
// dispatch-ambiguous task with no explicit mention of prune/sprout/
// mekiri-gate, and asks for a short reasoned tool choice before doing any
// real work -- this bounds cost regardless of what it decides, and the
// onSwitch/onHarvest stubs throw if it disobeys and calls prune/sprout
// anyway. Checks the full turn's content (text AND any tool-call inputs,
// not just printed text) for a mention of "mekiri-gate" by name, since the
// system prompt explicitly names it and a real live dogfooding run under
// this same wiring already showed the model narrating exactly this
// ("Использую gate: ...") once instructed.
describe("mekiri-host live smoke test: system prompt steers dispatch behavior", () => {
  it("proactively names mekiri-gate when facing a dispatch-ambiguous task, without being told to", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-sysprompt-smoke-"));

    try {
      const tools = createMekiriTools({
        dir: projectDir,
        depth: 0,
        isClone: false,
        backend: createClaudeCodeBackend(),
        getSessionId: () => "unused-in-this-test",
        getTranscript: () => [],
        onSwitch: () => {
          throw new Error("prune should not be called -- the task explicitly asks only for an explanation");
        },
        onHarvest: () => {
          throw new Error("harvest should not be called -- the task explicitly asks only for an explanation");
        },
        asyncSproutLimiter: createAsyncSproutLimiter(),
        onAsyncSproutComplete: () => {
          throw new Error("onAsyncSproutComplete should not be called in this test");
        },
      });

      const { iterable, push, close } = createInputQueue();
      push(
        [
          'Есть неоднозначная по способу решения задача: "Разберись с багом в парсере конфига, а я пока продолжаю писать документацию в другом месте."',
          "Прежде чем действовать, сначала одним-двумя предложениями объясни, каким способом и почему ты будешь её решать. Не выполняй саму работу и не вызывай prune/sprout/harvest/configure_mekiri -- просто объясни свой выбор и подожди подтверждения.",
        ].join("\n"),
      );
      close();

      const blocks: unknown[] = [];

      const q = query({
        prompt: iterable,
        options: buildQueryOptions({ resume: undefined, cwd: projectDir, mcpServers: { mekiri: tools } }),
      });
      for await (const message of q) {
        if (message.type === "assistant") {
          blocks.push(...message.message.content);
        }
      }

      const combined = JSON.stringify(blocks).toLowerCase();
      expect(combined).toContain("mekiri-gate");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Real, billed proof that the UserPromptSubmit hook's additionalContext
// genuinely reaches and is used by the model in a live session. Does NOT
// check for an SDKHookResponseMessage -- confirmed architecturally absent
// for in-process JS callback hooks by decompiling the bundled CLI (design
// spec §3.2). Instead asks the model to report what's already in its own
// context (without hinting at the answer) and checks its real response --
// the same technique that first proved this live with a marker phrase, and
// the same behavioral-proof pattern already used in the system-prompt
// plan's "steers dispatch behavior" test.
describe("mekiri-host live smoke test: UserPromptSubmit hook delivers the mekiri-tuning signal", () => {
  it("a real session's assistant response reflects the tuning signal injected via additionalContext", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "mekiri-host-hook-live-"));
    try {
      await mkdir(path.join(projectDir, ".mekiri"), { recursive: true });
      const lowRatioEntry = { event: "prune", timestamp: "2026-07-26T00:00:00.000Z", sessionId: "s1", newSessionId: "s2", noteType: "portal", removedBranchLength: 100, fruitLength: 80 };
      const lines = [lowRatioEntry, lowRatioEntry, lowRatioEntry].map((entry) => JSON.stringify(entry)).join("\n");
      await writeFile(path.join(projectDir, ".mekiri", "audit.jsonl"), `${lines}\n`, "utf8");

      const { iterable, push, close } = createInputQueue();
      push(
        [
          "Before doing anything else: state in one sentence whether you currently have any pending Mekiri tuning-related signal already present in your context (injected automatically -- not something you need to check any file for), and if so, quote it verbatim.",
          "Do not call any tools.",
        ].join("\n"),
      );
      close();

      const blocks: unknown[] = [];

      const q = query({
        prompt: iterable,
        options: buildQueryOptions({ resume: undefined, cwd: projectDir, mcpServers: {} }),
      });
      for await (const message of q) {
        if (message.type === "assistant") {
          blocks.push(...message.message.content);
        }
      }

      const combined = JSON.stringify(blocks);
      expect(combined).toContain("Distillation Ratio");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Real, billed proof that wait_mode:'async' genuinely returns before the
// clone finishes (not a disguised await) and that the result genuinely
// arrives later through onAsyncSproutComplete -- Task 2's unit tests only
// proved the rejection paths and the pure formatters in isolation.
describe("mekiri-host live smoke test: sprout async wait_mode", () => {
  it("returns pending immediately and delivers the result later via onAsyncSproutComplete", async () => {
    const dir = process.cwd();
    let parentSessionId: string | undefined;
    const asyncSproutLimiter = createAsyncSproutLimiter();

    let deliveredText: string | undefined;
    let resolveDelivered: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });

    const seed = createInputQueue();
    seed.push("Reply with exactly one word: ok");
    seed.close();
    const seedQuery = query({
      prompt: seed.iterable,
      options: buildQueryOptions({ resume: undefined, cwd: dir, mcpServers: {} }),
    });
    for await (const message of seedQuery) {
      if (message.type === "system" && message.subtype === "init") {
        parentSessionId = message.session_id;
      }
    }
    expect(parentSessionId).toBeTruthy();

    const context = {
      dir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => parentSessionId as string,
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("parent should not prune itself in this test");
      },
      onHarvest: () => {
        throw new Error("parent should never receive a harvest call directly");
      },
      asyncSproutLimiter,
      onAsyncSproutComplete: (injectText: string) => {
        deliveredText = injectText;
        resolveDelivered?.();
      },
    };

    const startedAt = Date.now();
    const output = await handleSprout(context, {
      task: "Immediately call the mcp__mekiri__harvest tool with result set to exactly the string ASYNC_SPROUT_OK and nothing else.",
      wait_mode: "async",
    });
    const respondedAfterMs = Date.now() - startedAt;

    const parsed = JSON.parse((output.content[0] as { text: string }).text);
    expect(parsed.status).toBe("ok");
    expect(parsed.pending).toBe(true);
    expect(parsed.child_session_id).toBeTruthy();
    // A real harvest round-trip takes several seconds; returning in under
    // 2s is the proof this was fire-and-forget, not a disguised await.
    expect(respondedAfterMs).toBeLessThan(2000);

    await delivered;
    expect(deliveredText).toContain(parsed.child_session_id);
    expect(deliveredText).toContain("ASYNC_SPROUT_OK");
  }, 60_000);

  it("rejects a second concurrent async sprout when parallelism.mode is 'single'", async () => {
    const dir = process.cwd();
    let parentSessionId: string | undefined;
    const asyncSproutLimiter = createAsyncSproutLimiter();
    const delivered: string[] = [];

    const seed = createInputQueue();
    seed.push("Reply with exactly one word: ok");
    seed.close();
    const seedQuery = query({
      prompt: seed.iterable,
      options: buildQueryOptions({ resume: undefined, cwd: dir, mcpServers: {} }),
    });
    for await (const message of seedQuery) {
      if (message.type === "system" && message.subtype === "init") {
        parentSessionId = message.session_id;
      }
    }
    expect(parentSessionId).toBeTruthy();

    const context = {
      dir,
      depth: 0,
      isClone: false,
      backend: createClaudeCodeBackend(),
      getSessionId: () => parentSessionId as string,
      getTranscript: () => [],
      onSwitch: () => {
        throw new Error("parent should not prune itself in this test");
      },
      onHarvest: () => {
        throw new Error("parent should never receive a harvest call directly");
      },
      asyncSproutLimiter,
      onAsyncSproutComplete: (injectText: string) => {
        delivered.push(injectText);
      },
    };

    const first = await handleSprout(context, {
      task: "Immediately call the mcp__mekiri__harvest tool with result set to exactly the string FIRST_OK and nothing else.",
      wait_mode: "async",
    });
    const firstParsed = JSON.parse((first.content[0] as { text: string }).text);
    expect(firstParsed.pending).toBe(true);

    const second = await handleSprout(context, {
      task: "irrelevant -- this should be rejected before any work starts",
      wait_mode: "async",
    });
    const secondParsed = JSON.parse((second.content[0] as { text: string }).text);
    expect(secondParsed.status).toBe("parallelism_limit_exceeded");
    expect(secondParsed.limit).toBe(1);
  }, 60_000);
});
