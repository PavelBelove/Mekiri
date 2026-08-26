import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

  it("is a no-op when called again with the same or a shorter array", async () => {
    const { appendNewShadowMessages, readShadowTranscript } = await import("../src/shadowTranscript.js");
    await appendNewShadowMessages("noop-session", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    // Simulates Claude Code's own file shrinking mid-compaction: the wire
    // array handed to appendNewShadowMessages must never cause the shadow
    // transcript to lose or rewrite what it already archived.
    await appendNewShadowMessages("noop-session", [{ role: "user", content: "a" }]);

    const transcript = await readShadowTranscript("noop-session");
    expect(transcript).toHaveLength(2);
    expect(transcript.map((l) => l.message?.content)).toEqual(["a", "b"]);
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

    await Promise.all([
      appendNewShadowMessages("concurrent-session", growingHistory(3)),
      appendNewShadowMessages("concurrent-session", growingHistory(5)),
      appendNewShadowMessages("concurrent-session", growingHistory(4)),
    ]);

    const transcript = await readShadowTranscript("concurrent-session");
    expect(transcript).toHaveLength(5);
    expect(transcript.map((l) => l.message?.content)).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4"]);
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
});
