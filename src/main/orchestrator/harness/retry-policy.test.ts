import { afterEach, describe, expect, it, vi } from "vitest";
import { decideRetry, sleepWithJitter } from "./retry-policy";

describe("decideRetry", () => {
  it("fatal / runtime_safety 永不重试（任何副作用分类）", () => {
    expect(decideRetry("fatal", "read_only")).toBe("no_retry");
    expect(decideRetry("fatal", "idempotent_mutation")).toBe("no_retry");
    expect(decideRetry("runtime_safety", "read_only")).toBe("no_retry");
  });

  it("non_idempotent_side_effect 任何 category 都不自动重试", () => {
    expect(decideRetry("timeout", "non_idempotent_side_effect")).toBe("no_retry");
    expect(decideRetry("transient", "non_idempotent_side_effect")).toBe("no_retry");
    expect(decideRetry("rate_limited", "non_idempotent_side_effect")).toBe("no_retry");
  });

  it("read_only 的 partial_failure 最多重试一次（保守）", () => {
    expect(decideRetry("partial_failure", "read_only")).toBe("retry");
    expect(decideRetry("partial_failure", "idempotent_mutation")).toBe("no_retry");
  });

  it("read_only / idempotent_mutation 的 transient/timeout/rate_limited 重试", () => {
    for (const sideEffect of ["read_only", "idempotent_mutation"] as const) {
      expect(decideRetry("transient", sideEffect)).toBe("retry");
      expect(decideRetry("timeout", sideEffect)).toBe("retry");
      expect(decideRetry("rate_limited", sideEffect)).toBe("retry");
    }
  });

  it("参数校验类错误不重试", () => {
    expect(decideRetry("invalid_arguments", "read_only")).toBe("no_retry");
    expect(decideRetry("not_found", "read_only")).toBe("no_retry");
    expect(decideRetry("permission_denied", "idempotent_mutation")).toBe("no_retry");
  });
});

describe("sleepWithJitter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the existing jittered delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let settled = false;
    void sleepWithJitter(1_000).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(1_149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("rejects immediately with AbortError without waiting for the jittered timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let outcome: unknown;
    void sleepWithJitter(1_000, controller.signal).then(
      () => { outcome = { status: "resolved" }; },
      (error) => { outcome = { status: "rejected", name: (error as Error).name }; },
    );

    controller.abort();
    await Promise.resolve();
    expect(outcome).toEqual({ status: "rejected", name: "AbortError" });
  });
});
