import { createHash } from "node:crypto";

// Claude Code re-serializes history between requests without changing its
// meaning: cache_control markers move to the newest messages, and a message
// holding one text block can come back as a plain string. A hash that
// identifies a message across requests has to ignore both.

export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== "cache_control") out[k] = stripCacheControl(v);
    }
    return out;
  }
  return value;
}

export function normalizedHash(message: unknown): string {
  const m = (typeof message === "object" && message !== null ? message : {}) as { role?: unknown; content?: unknown };
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : stripCacheControl(m.content);
  return createHash("sha256").update(JSON.stringify({ role: m.role, content })).digest("hex");
}
