import { describe, expect, it } from "vitest";
import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import { classifyToolExecutionMode, scheduleToolCalls } from "./tool-call-scheduler";

function call(name: string): ToolCall {
  return { id: `${name}-call`, name, arguments: "{}" };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "read_file",
    name: "Read file",
    description: "read",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind: "read",
    execute: async () => "ok",
    ...overrides,
  };
}

describe("classifyToolExecutionMode", () => {
  it("requires an explicit safe declaration for an ordinary read tool", () => {
    expect(classifyToolExecutionMode(call("read_file"), [tool()])).toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ isConcurrencySafe: () => true })])).toBe("parallel");
  });

  it("fails closed for mutation, checker failure, and Harness control tools", () => {
    expect(classifyToolExecutionMode(call("read_file"), [tool({ effectKind: "mutation", isConcurrencySafe: () => true })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ effectKind: "unknown", isConcurrencySafe: () => true })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ isConcurrencySafe: () => { throw new Error("bad classifier"); } })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("update_todo"), [])).toBe("exclusive");
    expect(classifyToolExecutionMode(call("task"), [])).toBe("exclusive");
  });

  it("allows only the read_tool_result builtin to join the safe pool", () => {
    expect(classifyToolExecutionMode(call("read_tool_result"), [])).toBe("parallel");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("scheduleToolCalls", () => {
  it("exposes original call indexes while commits wait for the earliest result", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const gates = calls.map(() => deferred<string>());
    const completed: number[] = [];
    const committed: number[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 3,
      classify: () => "parallel",
      execute: async (execution) => {
        const value = await gates[execution.toolCallIndex].promise;
        completed.push(execution.toolCallIndex);
        return value;
      },
      commit: async (execution) => {
        committed.push(execution.toolCallIndex);
        return "continue";
      },
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    gates[1].resolve("b");
    gates[2].resolve("c");
    await expect.poll(() => completed).toEqual([1, 2]);
    expect(committed).toEqual([]);
    gates[0].resolve("a");
    await scheduled;

    expect(committed).toEqual([0, 1, 2]);
  });

  it("keeps active safe calls within the configured rolling-pool limit", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const gates = calls.map(() => deferred<string>());
    let active = 0;
    let maximumActive = 0;
    const started: string[] = [];
    const committed: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: async (execution) => {
        const { call: toolCall, toolCallIndex: index } = execution;
        started.push(toolCall.name);
        active++;
        maximumActive = Math.max(maximumActive, active);
        const result = await gates[index].promise;
        active--;
        return result;
      },
      commit: async ({ call: toolCall }) => { committed.push(toolCall.name); return "continue"; },
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    gates[1].resolve("b");
    await expect.poll(() => started).toEqual(["a", "b", "c"]);
    gates[2].resolve("c");
    gates[0].resolve("a");
    await scheduled;

    expect(maximumActive).toBe(2);
    expect(committed).toEqual(["a", "b", "c"]);
  });

  it("drains a parallel group before it starts an exclusive barrier", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const a = deferred<string>();
    const b = deferred<string>();
    const trace: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: (toolCall) => toolCall.name === "c" ? "exclusive" : "parallel",
      execute: async ({ call: toolCall }) => {
        trace.push(`start:${toolCall.name}`);
        if (toolCall.name === "a") return a.promise;
        if (toolCall.name === "b") return b.promise;
        return "c";
      },
      commit: async () => "continue",
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    expect(trace).toEqual(["start:a", "start:b"]);
    b.resolve("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(["start:a", "start:b"]);
    a.resolve("a");
    await scheduled;

    expect(trace).toEqual(["start:a", "start:b", "start:c"]);
  });

  it("does not dispatch calls after cancellation and records them as not executed", async () => {
    const controller = new AbortController();
    controller.abort();
    const executed: string[] = [];
    const skipped: string[] = [];

    const result = await scheduleToolCalls({
      calls: [call("a"), call("b")],
      maxParallel: 4,
      signal: controller.signal,
      classify: () => "parallel",
      execute: async ({ call: toolCall }) => { executed.push(toolCall.name); return toolCall.name; },
      commit: async () => "continue",
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return reason;
      },
    });

    expect(result).toEqual({ cancelled: true, halted: false });
    expect(executed).toEqual([]);
    expect(skipped).toEqual(["a:aborted_before_dispatch", "b:aborted_before_dispatch"]);
  });

  it("halt mid-group: commits every executed result and marks only un-launched calls as not executed", async () => {
    // 4 调用、maxParallel=2：a/b 发射，commit(a) 返回 halt。
    // 不变量：b 已发射 → 必须最终 commit；c/d 从未发射 → notExecuted。
    const calls = [call("a"), call("b"), call("c"), call("d")];
    const gates = calls.map(() => deferred<string>());
    const commits: Array<{ name: string; result: unknown }> = [];
    const skipped: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: ({ toolCallIndex }) => gates[toolCallIndex].promise,
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return toolCall.name === "a" ? "halt" : "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await Promise.resolve();
    gates[0].resolve("a");
    await expect.poll(() => commits.map((entry) => entry.name)).toEqual(["a"]);
    // b 已发射：halt 只停止发射新调用，不丢弃已执行的事实
    gates[1].resolve("b");
    const result = await scheduled;

    expect(commits).toEqual([
      { name: "a", result: "a" },
      { name: "b", result: "b" },
      { name: "c", result: "synthetic:not_executed_after_halt" },
      { name: "d", result: "synthetic:not_executed_after_halt" },
    ]);
    expect(skipped).toEqual(["c:not_executed_after_halt", "d:not_executed_after_halt"]);
    expect(result).toEqual({ cancelled: false, halted: true });
  });

  it("execute error: commits a synthetic failure result, drains real siblings, then propagates the error", async () => {
    const calls = [call("a"), call("b")];
    const bGate = deferred<string>();
    const boom = new Error("execute infrastructure failure");
    const commits: Array<{ name: string; result: unknown }> = [];
    const synthetics: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: ({ call: toolCall }) => toolCall.name === "a"
        ? Promise.reject(boom)
        : bGate.promise,
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        synthetics.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await Promise.resolve();
    bGate.resolve("b");
    await expect(scheduled).rejects.toBe(boom);

    // transcript 闭合：a 合成失败结果 + b 真实结果都已按序提交
    expect(synthetics).toEqual(["a:execution_error"]);
    expect(commits).toEqual([
      { name: "a", result: "synthetic:execution_error" },
      { name: "b", result: "b" },
    ]);
  });

  it("execute error settling last: still commits its synthetic result before propagating", async () => {
    // b 的错误最后结算（a 先成功提交）：合成结果也必须落账，transcript 不得留洞
    const calls = [call("a"), call("b")];
    const boom = new Error("late execute failure");
    const commits: Array<{ name: string; result: unknown }> = [];
    const synthetics: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: ({ call: toolCall }) => toolCall.name === "a"
        ? Promise.resolve("a")
        : new Promise((_resolve, reject) => { setTimeout(() => reject(boom), 0); }),
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        synthetics.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await expect(scheduled).rejects.toBe(boom);

    expect(synthetics).toEqual(["b:execution_error"]);
    expect(commits).toEqual([
      { name: "a", result: "a" },
      { name: "b", result: "synthetic:execution_error" },
    ]);
  });

  it("execute error on a lone parallel call: commits its synthetic result before propagating", async () => {
    // 单调用组：错误槽位结算后没有兄弟触发提交循环，合成结果仍必须落账
    const boom = new Error("only call failed");
    const commits: Array<{ name: string; result: unknown }> = [];

    const scheduled = scheduleToolCalls({
      calls: [call("solo")],
      maxParallel: 2,
      classify: () => "parallel",
      execute: (): Promise<string> => Promise.reject(boom),
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async (_execution, reason) => `synthetic:${reason}`,
    });

    await expect(scheduled).rejects.toBe(boom);

    expect(commits).toEqual([{ name: "solo", result: "synthetic:execution_error" }]);
  });

  it("commit error: drains in-flight siblings, best-effort commits the rest, then propagates", async () => {
    const calls = [call("a"), call("b")];
    const bGate = deferred<string>();
    const commitBoom = new Error("commit consumer failure");
    const committed: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: ({ call: toolCall }) => toolCall.name === "b" ? bGate.promise : Promise.resolve("a"),
      commit: async ({ call: toolCall }) => {
        committed.push(toolCall.name);
        if (toolCall.name === "a") throw commitBoom;
        return "continue";
      },
      notExecuted: async (_execution, reason) => reason,
    });

    await Promise.resolve();
    bGate.resolve("b");
    await expect(scheduled).rejects.toBe(commitBoom);

    // commit 故障槽位是唯一接受的洞；后续已结算槽位仍尽力提交
    expect(committed).toEqual(["a", "b"]);
  });

  it("cancel mid-group: commits results settled before abort and marks un-launched calls as not executed", async () => {
    const calls = [call("a"), call("b"), call("c"), call("d")];
    const gates = calls.map(() => deferred<string>());
    const controller = new AbortController();
    const commits: Array<{ name: string; result: unknown }> = [];
    const skipped: string[] = [];
    const executed: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      signal: controller.signal,
      execute: ({ toolCallIndex, call: toolCall }) => {
        executed.push(toolCall.name);
        return gates[toolCallIndex].promise;
      },
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await Promise.resolve();
    gates[0].resolve("a");
    await expect.poll(() => commits.map((entry) => entry.name)).toEqual(["a"]);
    // a 已提交、c 已补位发射；此刻取消。b/c 被 abort 拒绝 → 接受的洞（恢复路径兜底），d 从未发射 → notExecuted
    expect(executed).toEqual(["a", "b", "c"]);
    controller.abort();
    gates[1].reject(new Error("aborted"));
    gates[2].reject(new Error("aborted"));

    const result = await scheduled;

    expect(result).toEqual({ cancelled: true, halted: false });
    expect(commits).toEqual([
      { name: "a", result: "a" },
      { name: "d", result: "synthetic:aborted_before_dispatch" },
    ]);
    expect(skipped).toEqual(["d:aborted_before_dispatch"]);
  });

  it("cancel during an exclusive call: keeps the started call open and closes only un-dispatched calls", async () => {
    // 已启动的独占工具（如发邮件）中途被取消：execute 已进入（runStore 已记 started、
    // 外部副作用可能已派发）。当前调用必须保留 started 交取消闭合写 unknown，
    // 不能改写成 aborted_before_dispatch（否则丢失非幂等副作用的 unknown 事实）。
    const calls = [call("send_email"), call("read_file")];
    const controller = new AbortController();
    const executed: string[] = [];
    const commits: Array<{ name: string; result: unknown }> = [];
    const skipped: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      signal: controller.signal,
      classify: () => "exclusive",
      execute: ({ call: toolCall }) => {
        executed.push(toolCall.name);
        // 模拟 raceWithSignal：abort 后以取消错误拒绝
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await Promise.resolve();
    expect(executed).toEqual(["send_email"]);
    controller.abort();

    const result = await scheduled;

    expect(result).toEqual({ cancelled: true, halted: false });
    // send_email 已派发：保留 started（由 closeInterruption 闭合为 unknown），
    // 只有从未派发的 read_file 被记为 aborted_before_dispatch。
    expect(skipped).toEqual(["read_file:aborted_before_dispatch"]);
    expect(commits).toEqual([{ name: "read_file", result: "synthetic:aborted_before_dispatch" }]);
  });

  it("execute error on an exclusive call: commits a synthetic failure and closes the rest before rethrowing", async () => {
    const calls = [call("a"), call("b")];
    const boom = new Error("exclusive infrastructure failure");
    const commits: Array<{ name: string; result: unknown }> = [];
    const skipped: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: (toolCall) => toolCall.name === "a" ? "exclusive" : "parallel",
      execute: ({ call: toolCall }) => toolCall.name === "a"
        ? Promise.reject(boom)
        : Promise.resolve("b"),
      commit: async ({ call: toolCall }, result) => {
        commits.push({ name: toolCall.name, result });
        return "continue";
      },
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return `synthetic:${reason}`;
      },
    });

    await expect(scheduled).rejects.toBe(boom);

    expect(commits).toEqual([
      { name: "a", result: "synthetic:execution_error" },
      { name: "b", result: "synthetic:not_executed_after_error" },
    ]);
    expect(skipped).toEqual(["a:execution_error", "b:not_executed_after_error"]);
  });
});
