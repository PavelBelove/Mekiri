import { describe, it, expect } from "vitest";
import { extractSessionId } from "../src/sessionMetadata.js";

describe("extractSessionId", () => {
  it("parses session_id out of metadata.user_id", () => {
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: "abc",
          account_uuid: "def",
          session_id: "session-123",
        }),
      },
    };
    expect(extractSessionId(body)).toBe("session-123");
  });

  it("returns undefined when metadata is missing", () => {
    expect(extractSessionId({})).toBeUndefined();
  });

  it("returns undefined when user_id is not valid JSON", () => {
    expect(extractSessionId({ metadata: { user_id: "not json" } })).toBeUndefined();
  });

  it("returns undefined when session_id field is missing", () => {
    const body = { metadata: { user_id: JSON.stringify({ device_id: "abc" }) } };
    expect(extractSessionId(body)).toBeUndefined();
  });
});
