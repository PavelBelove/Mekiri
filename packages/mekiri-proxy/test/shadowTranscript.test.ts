import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The real marker Claude Code's compaction summary starts with -- the shadow
// archive only accepts a changed first message as a new thread with it.
const SUMMARY = "This session is being continued from a previous conversation. compact-summary";

describe("shadowTranscript", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "mekiri-proxy-shadow-test-"));
    process.env.MEKIRI_PROXY_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MEKIRI_PROXY_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("readShadowTranscriptOrNull returns null when nothing has been archived yet", async () => {
    const { readShadowTranscriptOrNull } = await import("../src/shadowTranscript.js");
    expect(await readShadowTranscriptOrNull("s1")).toBeNull();
  });

  it("readShadowTranscript returns [] when nothing has been archived yet", async () => {
    const { readShadowTranscript } = await import("../src/shadowTranscript.js");
    expect(await readShadowTranscript("s1")).toEqual([]);
  });

  it("appends wire messages as RawLine-shaped entries, readable back in order", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("append-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);

    const transcript = await readShadowTranscript("append-session");
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ type: "user", message: { role: "user", content: "hello" } });
    expect(transcript[1]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    });
    expect(typeof transcript[0].uuid).toBe("string");
    expect(transcript[0].uuid).not.toBe(transcript[1].uuid);
  });

  it("only appends the new tail on a subsequent call with a longer array (Claude Code's own resend pattern)", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("tail-session", [{ role: "user", content: "first" }]);
    await appendNewShadowMessages("tail-session", [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);

    const transcript = await readShadowTranscript("tail-session");
    expect(transcript).toHaveLength(2);
    expect(transcript.map((l) => l.message?.content)).toEqual(["first", "second"]);
  });

  it("is a no-op when called again with the exact same array", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("noop-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    await appendNewShadowMessages("noop-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);

    const transcript = await readShadowTranscript("noop-session");
    expect(transcript).toHaveLength(2);
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b"]);
  });

  it("archives a shorter array instead of skipping it (native auto-compaction shrinks the wire array)", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("compact-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    // Compaction replaces older history with one synthetic summary message,
    // so the next request's array is shorter than the last one seen.
    await appendNewShadowMessages("compact-session", [{ role: "user", content: SUMMARY }]);

    const transcript = await readShadowTranscript("compact-session");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "c", SUMMARY]);
  });

  it("resumes normal incremental appends after a shrink, without re-duplicating on every subsequent call", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("post-compact-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    await appendNewShadowMessages("post-compact-session", [{ role: "user", content: SUMMARY }]);
    // Normal growth relative to the new, post-compaction baseline -- must
    // append only the one new tail message, not re-append the whole array.
    await appendNewShadowMessages("post-compact-session", [
      { role: "user", content: SUMMARY },
      { role: "assistant", content: "new turn" },
    ]);

    const transcript = await readShadowTranscript("post-compact-session");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "c", SUMMARY, "new turn"]);
  });

  it("keeps separate sessions in separate files", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("session-a", [{ role: "user", content: "from a" }]);
    await appendNewShadowMessages("session-b", [{ role: "user", content: "from b" }]);

    expect((await readShadowTranscript("session-a"))[0].message?.content).toBe("from a");
    expect((await readShadowTranscript("session-b"))[0].message?.content).toBe("from b");
  });

  it("serializes concurrent appends for the same session without interleaving or losing lines", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    const growingHistory = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }));

    // These three calls are issued concurrently but, since none of them
    // await before reaching the mutex, are enqueued in source order: 3, then
    // 5, then 4. The last one (4) is shorter than the immediately preceding
    // one (5) it's racing against -- indistinguishable, by length alone,
    // from a real compaction shrink -- so it's archived in full rather than
    // skipped. The mutex guarantees no interleaving/corruption and nothing
    // from msg 0..msg 4 is ever lost; msg 0..msg 3 end up duplicated, which
    // is the accepted trade-off for never silently dropping a real
    // post-compaction batch (see appendNewShadowMessages's doc comment).
    await Promise.all([
      appendNewShadowMessages("concurrent-session", growingHistory(3)),
      appendNewShadowMessages("concurrent-session", growingHistory(5)),
      appendNewShadowMessages("concurrent-session", growingHistory(4)),
    ]);

    const transcript = await readShadowTranscript("concurrent-session");
    const contents = transcript.map((l) => l.message?.content);
    expect(contents).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4", "msg 0", "msg 1", "msg 2", "msg 3"]);
    // No real content lost, regardless of the duplication above.
    expect(new Set(contents)).toEqual(new Set(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4"]));
  });

  it("reseeds its in-memory archived count from disk on first use after a restart", async () => {
    const first = await import("../src/shadowTranscript.js");
    await first.appendNewShadowMessages("restart-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);

    // vi.resetModules simulates a fresh daemon process: the in-memory
    // archivedCounts cache is gone, so the module must re-derive "already
    // archived 2" from the file on disk rather than re-archiving from 0.
    const { vi } = await import("vitest");
    vi.resetModules();
    const second = await import("../src/shadowTranscript.js");
    await second.appendNewShadowMessages("restart-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);

    const transcript = await second.readShadowTranscript("restart-session");
    expect(transcript).toHaveLength(3);
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "c"]);
  });
  it("archives an in-place edit of the last message as a revision line (interrupt case)", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    const toolResult = { type: "tool_result", tool_use_id: "t1", content: "ok" };
    await appendNewShadowMessages("interrupt-session", [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [toolResult] },
    ]);
    // Interrupt: same length, marker + new prompt merged into the last message.
    const edited = [
      toolResult,
      { type: "text", text: "[Request interrupted by user]" },
      { type: "text", text: "stop, do it differently" },
    ];
    await appendNewShadowMessages("interrupt-session", [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: edited },
    ]);
    // Unchanged resend must not add anything.
    await appendNewShadowMessages("interrupt-session", [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: edited },
    ]);

    const transcript = await readShadowTranscript("interrupt-session");
    expect(transcript).toHaveLength(4);
    expect(transcript[3].revision).toBe(true);
    expect(transcript[3].revisionOf).toBe(transcript[2].uuid);
    expect(new Set(transcript.map((l) => l.uuid)).size).toBe(4);
    expect(transcript[3].message?.content).toEqual(edited);
  });

  it("archives an edited previous-last message before the new tail when the array also grew", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("grow-edit-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    await appendNewShadowMessages("grow-edit-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b-edited" },
      { role: "user", content: "c" },
    ]);
    const transcript = await readShadowTranscript("grow-edit-session");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "b-edited", "c"]);
    expect(transcript[2].revisionOf).toBe(transcript[1].uuid);
    expect(transcript[3].revision).toBeUndefined();
  });

  it("reseeds correctly after a restart when revision lines are present", async () => {
    const first = await import("../src/shadowTranscript.js");
    await first.appendNewShadowMessages("restart-revision-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    await first.appendNewShadowMessages("restart-revision-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b2" },
    ]);

    const { vi } = await import("vitest");
    vi.resetModules();
    const second = await import("../src/shadowTranscript.js");
    // Same array again: nothing new (length from non-revision lines, hash from last line).
    await second.appendNewShadowMessages("restart-revision-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b2" },
    ]);
    await second.appendNewShadowMessages("restart-revision-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b2" },
      { role: "user", content: "c" },
    ]);
    const transcript = await second.readShadowTranscript("restart-revision-session");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "b2", "c"]);
    expect(new Set(transcript.map((l) => l.uuid)).size).toBe(4);
  });
  it("ignores side requests that share the session id (auto-mode classifier)", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    const main = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    expect(await appendNewShadowMessages("side-session", main)).toBe(true);
    expect(
      await appendNewShadowMessages("side-session", [
        { role: "user", content: [{ type: "text", text: "The following is the user's CLAUDE.md configuration." }] },
        { role: "user", content: [{ type: "text", text: "<transcript>" }] },
      ]),
    ).toBe(false);
    expect(await appendNewShadowMessages("side-session", [...main, { role: "assistant", content: "d" }])).toBe(true);

    const transcript = await readShadowTranscript("side-session");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "c", "d"]);
  });

  it("after a restart, tracks the thread from the last compaction summary on disk", async () => {
    const first = await import("../src/shadowTranscript.js");
    await first.appendNewShadowMessages("restart-compact", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    await first.appendNewShadowMessages("restart-compact", [{ role: "user", content: SUMMARY }]);

    const { vi } = await import("vitest");
    vi.resetModules();
    const second = await import("../src/shadowTranscript.js");
    expect(
      await second.appendNewShadowMessages("restart-compact", [
        { role: "user", content: SUMMARY },
        { role: "assistant", content: "d" },
      ]),
    ).toBe(true);
    const transcript = await second.readShadowTranscript("restart-compact");
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b", "c", SUMMARY, "d"]);
  });
});
