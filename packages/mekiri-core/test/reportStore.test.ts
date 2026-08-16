import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  recordDistillate,
  readReportRange,
  readCapsule,
  findCapsuleEntry,
  ensureSessionAlias,
  writeSessionsIndex,
  slugify,
  type ReportEntryMeta,
} from "../src/reportStore.js";

function meta(overrides: Partial<ReportEntryMeta> = {}): ReportEntryMeta {
  return {
    event: "prune",
    sessionId: "session-1",
    ruleId: "rule-1",
    noteType: "portal",
    timestamp: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("reportStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mekiri-reportstore-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a 1-indexed range matching the appended text's real line count on an empty dir", async () => {
    const bodyText = "line one\nline two\nline three";
    const { startLine, endLine } = await recordDistillate(dir, meta(), "first header", bodyText);

    expect(startLine).toBe(1);
    // 1 metadata line + 3 body lines = 4 lines total.
    expect(endLine).toBe(4);

    const reportPath = path.join(dir, ".mekiri", "sessions", "session-1", "report.md");
    const capsulePath = path.join(dir, ".mekiri", "sessions", "session-1", "capsule.md");
    const indexPath = path.join(dir, ".mekiri", "capsule-index.jsonl");

    const reportRaw = await fs.readFile(reportPath, "utf8");
    expect(reportRaw.split("\n").length - 1).toBe(4); // trailing newline accounted for
    expect(reportRaw).toContain(bodyText);

    const capsuleRaw = await fs.readFile(capsulePath, "utf8");
    expect(capsuleRaw).toBe("«first header» 1-4 — prune rule-1\n");

    const indexRaw = await fs.readFile(indexPath, "utf8");
    const indexEntry = JSON.parse(indexRaw.trim());
    expect(indexEntry).toEqual({
      ruleId: "rule-1",
      header: "first header",
      startLine: 1,
      endLine: 4,
      event: "prune",
      sessionId: "session-1",
      timestamp: "2026-08-04T00:00:00.000Z",
    });
  });

  it("a second call's startLine is previous endLine + 1 (no gap, no overlap)", async () => {
    const first = await recordDistillate(dir, meta({ ruleId: "rule-1" }), "h1", "body one\nbody one line two");
    const second = await recordDistillate(dir, meta({ ruleId: "rule-2" }), "h2", "body two");

    expect(second.startLine).toBe(first.endLine + 1);
  });

  it("serializes 5 concurrent calls into non-overlapping ranges with no interleaving corruption", async () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      recordDistillate(dir, meta({ ruleId: `rule-${i}` }), `header-${i}`, `body for entry ${i}`),
    );
    const results = await Promise.all(calls);

    // Ranges must partition [1, N] with no gaps and no overlaps, in some order.
    const sorted = [...results].sort((a, b) => a.startLine - b.startLine);
    let expectedStart = 1;
    for (const range of sorted) {
      expect(range.startLine).toBe(expectedStart);
      expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
      expectedStart = range.endLine + 1;
    }

    const capsuleRaw = await readCapsule(dir, "session-1");
    const capsuleLines = capsuleRaw.split("\n").filter((l) => l.length > 0);
    expect(capsuleLines).toHaveLength(5);

    const indexPath = path.join(dir, ".mekiri", "capsule-index.jsonl");
    const indexRaw = await fs.readFile(indexPath, "utf8");
    const indexLines = indexRaw.split("\n").filter((l) => l.length > 0);
    expect(indexLines).toHaveLength(5);
    for (const line of indexLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("findCapsuleEntry returns the right entry by ruleId, undefined for unknown id or missing .mekiri/", async () => {
    await recordDistillate(dir, meta({ ruleId: "rule-a" }), "header a", "body a");
    await recordDistillate(dir, meta({ ruleId: "rule-b", event: "tag" }), "header b", "body b");

    const entryA = await findCapsuleEntry(dir, "rule-a");
    expect(entryA).toEqual(
      expect.objectContaining({ ruleId: "rule-a", header: "header a", event: "prune" }),
    );

    const entryB = await findCapsuleEntry(dir, "rule-b");
    expect(entryB).toEqual(
      expect.objectContaining({ ruleId: "rule-b", header: "header b", event: "tag" }),
    );

    expect(await findCapsuleEntry(dir, "rule-unknown")).toBeUndefined();

    const emptyDir = await mkdtemp(path.join(tmpdir(), "mekiri-reportstore-empty-"));
    try {
      expect(await findCapsuleEntry(emptyDir, "rule-a")).toBeUndefined();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("readReportRange returns exactly the body text for a given entry, not neighboring entries' content", async () => {
    const first = await recordDistillate(dir, meta({ ruleId: "rule-1" }), "h1", "first body\nsecond line of first");
    const second = await recordDistillate(dir, meta({ ruleId: "rule-2" }), "h2", "second body only line");

    const firstRange = await readReportRange(dir, "session-1", first.startLine, first.endLine);
    expect(firstRange).toContain("first body\nsecond line of first");
    expect(firstRange).not.toContain("second body only line");

    const secondRange = await readReportRange(dir, "session-1", second.startLine, second.endLine);
    expect(secondRange).toContain("second body only line");
    expect(secondRange).not.toContain("first body");
  });

  it("readCapsule returns empty string when no .mekiri/ exists yet", async () => {
    expect(await readCapsule(dir, "session-1")).toBe("");
  });

  it("scopes report.md/capsule.md per sessionId while capsule-index.jsonl stays project-wide", async () => {
    const fromA = await recordDistillate(dir, meta({ ruleId: "rule-a", sessionId: "session-a" }), "header a", "body from session a");
    const fromB = await recordDistillate(dir, meta({ ruleId: "rule-b", sessionId: "session-b" }), "header b", "body from session b");

    const capsuleA = await readCapsule(dir, "session-a");
    expect(capsuleA).toContain("header a");
    expect(capsuleA).not.toContain("header b");

    const capsuleB = await readCapsule(dir, "session-b");
    expect(capsuleB).toContain("header b");
    expect(capsuleB).not.toContain("header a");

    // capsule-index.jsonl is project-wide: findCapsuleEntry must resolve
    // ruleIds from either session regardless of which session is "current".
    const entryA = await findCapsuleEntry(dir, "rule-a");
    const entryB = await findCapsuleEntry(dir, "rule-b");
    expect(entryA?.sessionId).toBe("session-a");
    expect(entryB?.sessionId).toBe("session-b");

    // A caller in session-b's context can still read session-a's report body
    // by routing through the entry's own sessionId, not the caller's.
    const crossSessionRead = await readReportRange(dir, entryA!.sessionId, fromA.startLine, fromA.endLine);
    expect(crossSessionRead).toContain("body from session a");
    void fromB;
  });

  describe("slugify", () => {
    it("transliterates Cyrillic to ascii kebab-case and truncates", () => {
      expect(slugify("Изучена структура репозитория")).toBe("izuchena-struktura-repozitoriya");
      expect(slugify("Hello, World!!!")).toBe("hello-world");
      expect(slugify("a".repeat(60))).toHaveLength(40);
    });
  });

  describe("ensureSessionAlias", () => {
    it("creates a dir symlink named <date>-<slug> pointing at the sessionId directory", async () => {
      const alias = await ensureSessionAlias(dir, "session-xyz", "Прочитан файл ради вопроса", "2026-08-06T09:00:00.000Z");

      expect(alias).toBe("2026-08-06-prochitan-fayl-radi-voprosa");
      const linkPath = path.join(dir, ".mekiri", "sessions", alias);
      const stat = await fs.lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(linkPath)).toBe("session-xyz");
    });

    it("is idempotent per session: second call returns the same alias without creating a second symlink", async () => {
      const first = await ensureSessionAlias(dir, "session-xyz", "first header", "2026-08-06T09:00:00.000Z");
      const second = await ensureSessionAlias(dir, "session-xyz", "unrelated later header", "2026-08-06T10:00:00.000Z");

      expect(second).toBe(first);
      const entries = await fs.readdir(path.join(dir, ".mekiri", "sessions"));
      expect(entries.filter((e) => e !== "session-xyz")).toHaveLength(1);
    });

    it("resolves a slug collision between two sessions with a numeric suffix", async () => {
      const first = await ensureSessionAlias(dir, "session-a", "same header", "2026-08-06T09:00:00.000Z");
      const second = await ensureSessionAlias(dir, "session-b", "same header", "2026-08-06T09:00:00.000Z");

      expect(first).not.toBe(second);
      expect(second).toBe(`${first}-2`);
    });
  });

  describe("writeSessionsIndex", () => {
    it("writes one row per session with correct prune/tag counts and alias", async () => {
      await recordDistillate(dir, meta({ sessionId: "session-a", ruleId: "rule-a1", event: "prune" }), "first in session a", "body");
      await recordDistillate(dir, meta({ sessionId: "session-a", ruleId: "rule-a2", event: "tag" }), "second in session a", "body");
      await recordDistillate(dir, meta({ sessionId: "session-b", ruleId: "rule-b1", event: "prune" }), "first in session b", "body");

      const content = await fs.readFile(path.join(dir, ".mekiri", "sessions-index.md"), "utf8");

      expect(content).toContain("1 prune / 1 tag");
      expect(content).toContain("first in session a");
      expect(content).toContain("1 prune / 0 tag");
      expect(content).toContain("first in session b");

      const rows = content.split("\n").filter((l) => l.startsWith("- **"));
      expect(rows).toHaveLength(2);
    });

    it("recordDistillate keeps sessions-index.md in sync automatically", async () => {
      await recordDistillate(dir, meta({ sessionId: "session-only" }), "only entry", "body");
      const content = await fs.readFile(path.join(dir, ".mekiri", "sessions-index.md"), "utf8");
      expect(content).toContain("only entry");

      await writeSessionsIndex(dir);
      const contentAfterManualCall = await fs.readFile(path.join(dir, ".mekiri", "sessions-index.md"), "utf8");
      expect(contentAfterManualCall).toBe(content);
    });
  });
});
