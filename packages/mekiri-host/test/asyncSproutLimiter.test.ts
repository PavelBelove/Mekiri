import { describe, it, expect } from "vitest";
import { createAsyncSproutLimiter } from "../src/asyncSproutLimiter.js";

describe("createAsyncSproutLimiter", () => {
  it("allows acquiring up to the limit", () => {
    const limiter = createAsyncSproutLimiter();
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.active).toBe(1);
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.active).toBe(2);
  });

  it("rejects once the limit is reached", () => {
    const limiter = createAsyncSproutLimiter();
    limiter.tryAcquire(1);
    expect(limiter.tryAcquire(1)).toBe(false);
    expect(limiter.active).toBe(1);
  });

  it("frees a slot on release, allowing another acquire", () => {
    const limiter = createAsyncSproutLimiter();
    limiter.tryAcquire(1);
    expect(limiter.tryAcquire(1)).toBe(false);
    limiter.release();
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire(1)).toBe(true);
  });

  it("does not go negative if release is called more than acquire", () => {
    const limiter = createAsyncSproutLimiter();
    limiter.release();
    limiter.release();
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire(1)).toBe(true);
  });

  it("a limit of 0 rejects immediately", () => {
    const limiter = createAsyncSproutLimiter();
    expect(limiter.tryAcquire(0)).toBe(false);
  });
});
