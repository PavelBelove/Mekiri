import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_ROOT = path.join(import.meta.dirname, "..", "skills-plugin");

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("no frontmatter block found");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    fields[key] = value;
  }
  return fields;
}

describe("skills-plugin manifest", () => {
  it("plugin.json has the required fields", async () => {
    const raw = await readFile(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.name).toBe("mekiri");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.each(["mekiri-gate", "mekiri-tuning"])("skills-plugin skill: %s", (skillName) => {
  it("SKILL.md frontmatter has a matching name and non-empty description", async () => {
    const raw = await readFile(path.join(PLUGIN_ROOT, "skills", skillName, "SKILL.md"), "utf8");
    const fields = parseFrontmatter(raw);
    expect(fields.name).toBe(skillName);
    expect(fields.description.length).toBeGreaterThan(0);
  });
});
