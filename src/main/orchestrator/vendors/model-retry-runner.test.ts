import { describe, expect, it } from "vitest";
import { AgentRuntimeError } from "../agent-runtime-error";

async function loadRunner() {
  const runner = await import("./model-retry-runner").catch(() => undefined);
  expect(runner).toBeDefined();
  return runner!;
}

function transientError(retryAfterMs = 0) {
  const error = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型暂不可用。", {
    modelFailure: { provider: "test", model: "m", category: "SERVER_ERROR", retryable: true },
  }) as AgentRuntimeError & { retryAfterMs?: number };
  error.retryAfterMs = retryAfterMs;
  return error;
}

describe("runModelRequestWithRetry", () => {
  it("在预算内重试暂时故障，包括 MiniMax 风格 529 和未知网络异常", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    const errors = [
      new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "HTTP 529 server_error", {
        modelFailure: { provider: "minimax", model: "MiniMax-M3", category: "UNKNOWN", status: 529, vendorCode: "server_error" },
      }),
      new Error("unclassified request failure"),
    ];

    for (const error of errors) {
      Object.assign(error, { retryAfterMs: 0 });
      let calls = 0;
      await expect(runModelRequestWithRetry(async () => {
        calls += 1;
        if (calls === 1) throw error;
        return "recovered";
      }, { provider: "minimax", model: "MiniMax-M3", maxRetries: 1, idleTimeoutMs: 1_000 })).resolves.toBe("recovered");
      expect(calls).toBe(2);
    }
  });

  it.each(["AUTH", "PERMISSION", "BILLING", "QUOTA", "INVALID_REQUEST", "NOT_FOUND", "CONTEXT_LIMIT", "PAYLOAD_TOO_LARGE", "CONTENT_POLICY", "CONFLICT", "CANCELLED"] as const)("does not repeat a terminal %s failure", async (category) => {
    const { runModelRequestWithRetry } = await loadRunner();
    const error = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "permanent failure", {
      modelFailure: { provider: "chatgpt", model: "m", category },
    });
    let calls = 0;
    const statuses: unknown[] = [];
    await expect(runModelRequestWithRetry(async () => { calls += 1; throw error; }, {
      provider: "chatgpt", model: "m", maxRetries: 5, idleTimeoutMs: 1000,
      onStatus: (status) => statuses.push(status),
    })).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(statuses).toEqual([]);
  });

  it.each([400, 401, 403, 404, 409, 413, 422])("does not repeat an unclassified HTTP %s admission failure", async (status) => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    const error = new Error("admission failed", { cause: Object.assign(new Error("upstream"), { status }) });
    await expect(runModelRequestWithRetry(async () => { calls += 1; throw error; }, {
      provider: "unknown", model: "m", maxRetries: 5, idleTimeoutMs: 1000,
    })).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it("respects retryable:false even for an unknown error", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    const error = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "terminal", {
      modelFailure: { provider: "unknown", model: "m", category: "UNKNOWN", retryable: false },
    });
    await expect(runModelRequestWithRetry(async () => { calls += 1; throw error; }, {
      provider: "unknown", model: "m", maxRetries: 5, idleTimeoutMs: 1000,
    })).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it("最多执行首次请求加用户配置的额外次数", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    await expect(runModelRequestWithRetry(async () => {
      calls += 1;
      throw transientError();
    }, { provider: "test", model: "m", maxRetries: 2, idleTimeoutMs: 1_000 })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(3);
  });

  it("首次请求收到可见增量后不重发", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    await expect(runModelRequestWithRetry(async ({ onVisibleDelta }) => {
      calls += 1;
      onVisibleDelta();
      throw transientError();
    }, {
      provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 1_000,
    })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(1);
  });

  it("重试后收到可见增量时清状态并停止后续重发", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    const statuses: string[] = [];
    await expect(runModelRequestWithRetry(async ({ onVisibleDelta }) => {
      calls += 1;
      if (calls === 1) throw transientError();
      onVisibleDelta();
      throw transientError();
    }, {
      provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 1_000,
      onStatus: (status) => statuses.push(status.phase),
    })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(2);
    expect(statuses).toEqual(["waiting", "attempting", "cleared"]);
  });

  it("取消退避等待后不发起下一次请求", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    const controller = new AbortController();
    let calls = 0;
    const statuses: string[] = [];
    const pending = runModelRequestWithRetry(async () => {
      calls += 1;
      throw transientError(50_000);
    }, {
      provider: "test", model: "m", maxRetries: 2, idleTimeoutMs: 1_000,
      signal: controller.signal,
      onStatus: (status) => {
        statuses.push(status.phase);
        if (status.phase === "waiting") controller.abort();
      },
    });
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
    expect(statuses.at(-1)).toBe("cleared");
  });
});
