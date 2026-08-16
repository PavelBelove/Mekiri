import { describe, it, expect } from "vitest";
import { findUnverifiedPaths } from "../src/verifyFruitEvidence.js";
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
