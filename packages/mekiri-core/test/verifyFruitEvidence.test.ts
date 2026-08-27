import { describe, it, expect } from "vitest";
import { findUnverifiedPaths, summarizeToolActivity } from "../src/verifyFruitEvidence.js";
import type { PortalFruit, RawLine } from "../src/types.js";

function toolUseLine(name: string, input: Record<string, unknown>): RawLine {
  return {
    type: "assistant",
    uuid: "asst-tool",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input } as unknown as { type: string; text?: string }],
    },
  };
}

function textLine(text: string): RawLine {
  return { type: "assistant", uuid: "asst-text", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("findUnverifiedPaths", () => {
  it("returns an empty array when the fruit has no files_touched", () => {
    const fruit: PortalFruit = { summary: "did something" };
    expect(findUnverifiedPaths([textLine("hi")], fruit)).toEqual([]);
  });

  it("finds no unverified paths when a Write tool_use matches the fruit's relative path", () => {
    const range = [toolUseLine("Write", { file_path: "/home/pol/dev/rollback/README.md" })];
    const fruit: PortalFruit = { summary: "translated", files_touched: [{ path: "README.md", change: "translated to English" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual([]);
  });

  it("matches a nested relative path via suffix, not just the basename", () => {
    const range = [toolUseLine("Edit", { file_path: "/home/pol/dev/rollback/docs/mechanics/gate.md" })];
    const fruit: PortalFruit = { summary: "edited", files_touched: [{ path: "docs/mechanics/gate.md", change: "x" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual([]);
  });

  it("does not match a different file that merely shares a basename", () => {
    const range = [toolUseLine("Write", { file_path: "/home/pol/other-project/docs/mechanics/gate.md" })];
    const fruit: PortalFruit = { summary: "edited", files_touched: [{ path: "docs/mechanics/gate.md", change: "x" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual([]);
  });

  it("flags a path with no matching tool_use anywhere in range as unverified", () => {
    const range = [textLine("I translated the file"), toolUseLine("Read", { file_path: "/home/pol/dev/rollback/README.md" })];
    const fruit: PortalFruit = { summary: "translated", files_touched: [{ path: "README.md", change: "translated to English" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual(["README.md"]);
  });

  it("ignores non-mutating tools like Read and Bash when looking for evidence", () => {
    const range = [
      toolUseLine("Read", { file_path: "/home/pol/dev/rollback/README.md" }),
      toolUseLine("Bash", { command: "grep -c foo README.md" }),
    ];
    const fruit: PortalFruit = { summary: "translated", files_touched: [{ path: "README.md", change: "x" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual(["README.md"]);
  });

  it("recognizes NotebookEdit as mutating evidence", () => {
    const range = [toolUseLine("NotebookEdit", { notebook_path: "/x/nb.ipynb", file_path: "/x/nb.ipynb" })];
    const fruit: PortalFruit = { summary: "edited notebook", files_touched: [{ path: "nb.ipynb", change: "x" }] };
    expect(findUnverifiedPaths(range, fruit)).toEqual([]);
  });

  it("partitions multiple files_touched into verified and unverified independently", () => {
    const range = [toolUseLine("Write", { file_path: "/home/pol/dev/rollback/README.md" })];
    const fruit: PortalFruit = {
      summary: "translated two files",
      files_touched: [
        { path: "README.md", change: "translated" },
        { path: "docs/philosophy.md", change: "translated" },
      ],
    };
    expect(findUnverifiedPaths(range, fruit)).toEqual(["docs/philosophy.md"]);
  });

  it("returns all paths unverified for an empty range", () => {
    const fruit: PortalFruit = { summary: "x", files_touched: [{ path: "a.md", change: "x" }] };
    expect(findUnverifiedPaths([], fruit)).toEqual(["a.md"]);
  });
});

describe("summarizeToolActivity", () => {
  it("returns an empty string for a range with no tool_use blocks", () => {
    expect(summarizeToolActivity([textLine("just talking")])).toBe("");
  });

  it("returns an empty string for an empty range", () => {
    expect(summarizeToolActivity([])).toBe("");
  });

  it("formats a single tool_use with a derivable label", () => {
    const range = [toolUseLine("Read", { file_path: "/home/pol/dev/rollback/README.md" })];
    expect(summarizeToolActivity(range)).toBe("Read×1(/home/pol/dev/rollback/README.md)");
  });

  it("counts repeated calls to the same tool and dedupes identical labels", () => {
    const range = [
      toolUseLine("Read", { file_path: "/x/a.md" }),
      toolUseLine("Read", { file_path: "/x/a.md" }),
      toolUseLine("Read", { file_path: "/x/b.md" }),
    ];
    expect(summarizeToolActivity(range)).toBe("Read×3(/x/a.md, /x/b.md)");
  });

  it("lists multiple distinct tools in first-seen order", () => {
    const range = [
      toolUseLine("Read", { file_path: "/x/a.md" }),
      toolUseLine("Bash", { command: "npm test" }),
      toolUseLine("Edit", { file_path: "/x/b.md" }),
    ];
    expect(summarizeToolActivity(range)).toBe("Read×1(/x/a.md), Bash×1(npm test), Edit×1(/x/b.md)");
  });

  it("still counts a tool_use with no derivable label", () => {
    const range = [toolUseLine("TodoWrite", { todos: [] })];
    expect(summarizeToolActivity(range)).toBe("TodoWrite×1");
  });

  it("truncates a long command label to 40 chars with ellipsis", () => {
    const longCommand = "a".repeat(50);
    const range = [toolUseLine("Bash", { command: longCommand })];
    expect(summarizeToolActivity(range)).toBe(`Bash×1(${"a".repeat(40)}...)`);
  });

  it("caps the label list at 3 with an ellipsis marker for more", () => {
    const range = [
      toolUseLine("Read", { file_path: "/x/a.md" }),
      toolUseLine("Read", { file_path: "/x/b.md" }),
      toolUseLine("Read", { file_path: "/x/c.md" }),
      toolUseLine("Read", { file_path: "/x/d.md" }),
    ];
    expect(summarizeToolActivity(range)).toBe("Read×4(/x/a.md, /x/b.md, /x/c.md, ...)");
  });
});
