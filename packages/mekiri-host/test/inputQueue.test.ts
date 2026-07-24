import { describe, it, expect } from "vitest";
import { createInputQueue } from "../src/inputQueue.js";

describe("createInputQueue", () => {
  it("yields pushed messages in order", async () => {
    const { iterable, push, close } = createInputQueue();
    push("first");
    push("second");
    close();

    const results: string[] = [];
    for await (const msg of iterable) {
      results.push(msg.message.content as string);
    }
    expect(results).toEqual(["first", "second"]);
  });

  it("yields a message pushed after the consumer is already waiting", async () => {
    const { iterable, push, close } = createInputQueue();
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();

    push("delayed");
    const result = await pending;

    expect(result.done).toBe(false);
    expect(result.value?.message.content).toBe("delayed");
    close();
  });

  it("stamps origin as human on every message", async () => {
    const { iterable, push, close } = createInputQueue();
    push("hi");
    close();

    for await (const msg of iterable) {
      expect(msg.origin).toEqual({ kind: "human" });
      expect(msg.type).toBe("user");
      expect(msg.parent_tool_use_id).toBeNull();
    }
  });

  it("ends iteration when closed with no pending messages", async () => {
    const { iterable, close } = createInputQueue();
    close();
    const iterator = iterable[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("ends iteration when closed while a consumer is waiting", async () => {
    const { iterable, close } = createInputQueue();
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    close();
    const result = await pending;
    expect(result.done).toBe(true);
  });
});
