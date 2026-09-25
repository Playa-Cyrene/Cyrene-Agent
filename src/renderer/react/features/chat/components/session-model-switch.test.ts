import { describe, expect, it, vi } from "vitest";
import { createSessionModelSwitcher } from "./session-model-switch";

/** 受控延迟的 IPC mock：resolve/reject 由测试手动放行 */
function makeControlledIpc<TSession>() {
  const calls: Array<{ kind: "profile" | "model"; args: unknown[]; resolve: (value: TSession | null) => void; reject: (error: unknown) => void }> = [];
  const ipc = {
    setModelProfile: vi.fn((sessionId: string, modelProfileId: string) =>
      new Promise<TSession | null>((resolve, reject) => {
        calls.push({ kind: "profile", args: [sessionId, modelProfileId], resolve, reject });
      })),
    setSessionModel: vi.fn((sessionId: string, model: string) =>
      new Promise<{ ok: true; session: TSession; } | { ok: false; error: string }>((resolve, reject) => {
        calls.push({ kind: "model", args: [sessionId, model], resolve: (value) => resolve(value as never), reject });
      })),
  };
  return { ipc, calls };
}

describe("session-model-switch（renderer barrier + operation token）", () => {
  it("#21/#13 barrier：切模型 pending 时 barrier() 不放行，mutation 提交后立即放行", async () => {
    const { ipc, calls } = makeControlledIpc<{ id: string; model: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    switcher.switchModel("s1", "glm-flash");
    let barrierDone = false;
    const barrier = switcher.barrier().then(() => { barrierDone = true; });

    // mutation 未提交：barrier 不得放行（发送若此时进行会读到旧模型）
    await Promise.resolve();
    expect(barrierDone).toBe(false);

    // 放行切模型 IPC（成功）→ barrier 完成
    calls[0].resolve({ ok: true, session: { id: "s1", model: "glm-flash" } });
    await barrier;
    expect(barrierDone).toBe(true);
    expect(onSessionUpdated).toHaveBeenCalledWith({ id: "s1", model: "glm-flash" });
  });

  it("#21 barrier 在无 pending 时立即放行（发送不被拖慢）", async () => {
    const { ipc } = makeControlledIpc<{ id: string }>();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated: vi.fn() });
    await expect(switcher.barrier()).resolves.toBeUndefined();
  });

  it("#20 token：B pending → C success → B 迟到失败 → UI 最终态仍为 C", async () => {
    const { ipc, calls } = makeControlledIpc<{ model: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    // B 切模型（挂起）
    switcher.switchModel("s1", "model-b");
    // C 切模型（立刻成功）
    switcher.switchModel("s1", "model-c");
    calls[1].resolve({ ok: true, session: { model: "model-c" } });
    await vi.waitFor(() => expect(onSessionUpdated).toHaveBeenCalledTimes(1));
    expect(onSessionUpdated).toHaveBeenCalledWith({ model: "model-c" });

    // B 迟到失败：token 已过期 → 不得回写 UI（不打回 A/不留错误状态）
    calls[0].resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSessionUpdated).toHaveBeenCalledTimes(1);
    expect(onSessionUpdated).toHaveBeenLastCalledWith({ model: "model-c" });
  });

  it("#20 token 跨操作类型：切档案 pending → 切模型 success → 切档案迟到失败不覆盖", async () => {
    const { ipc, calls } = makeControlledIpc<{ model: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    switcher.switchProfile("s1", "p-b");   // 切档案挂起
    switcher.switchModel("s1", "glm-x");   // 切模型立刻成功
    calls[1].resolve({ ok: true, session: { model: "glm-x" } });
    await vi.waitFor(() => expect(onSessionUpdated).toHaveBeenCalledTimes(1));

    calls[0].resolve(null);                // 切档案迟到失败
    await Promise.resolve();
    await Promise.resolve();
    expect(onSessionUpdated).toHaveBeenLastCalledWith({ model: "glm-x" });
  });

  it("#11 失败不假装成功：最新一次切模型失败（ok:false）→ 不触发 UI 更新", async () => {
    const { ipc, calls } = makeControlledIpc<{ model: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    switcher.switchModel("s1", "invalid-model");
    calls[0].resolve({ ok: false, error: "invalid-model" });
    await switcher.barrier();
    expect(onSessionUpdated).not.toHaveBeenCalled();
  });

  it("#11 切档案失败（返回 null）→ 不触发 UI 更新（不假装成功）", async () => {
    const { ipc, calls } = makeControlledIpc<{ id: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    switcher.switchProfile("s1", "p-missing");
    calls[0].resolve(null);
    await switcher.barrier();
    expect(onSessionUpdated).not.toHaveBeenCalled();
  });

  it("barrier 等最新一笔：A 完成后 pending 清空，后续发送不等旧操作", async () => {
    const { ipc, calls } = makeControlledIpc<{ model: string }>();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated: vi.fn() });

    switcher.switchModel("s1", "model-a");
    calls[0].resolve({ ok: true, session: { model: "model-a" } });
    await switcher.barrier();

    // 旧操作已完成：新 barrier 立即放行（pending 队尾自动清理）
    await expect(switcher.barrier()).resolves.toBeUndefined();
  });

  it("IPC 异常（reject）：不触发 UI 更新且不卡后续 barrier", async () => {
    const { ipc, calls } = makeControlledIpc<{ model: string }>();
    const onSessionUpdated = vi.fn();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated });

    switcher.switchModel("s1", "boom");
    calls[0].reject(new Error("ipc down"));
    await expect(switcher.barrier()).resolves.toBeUndefined();
    expect(onSessionUpdated).not.toHaveBeenCalled();
  });
});

// 端到端版（#21）：不再手工放行 Promise，而是模拟真实跨层时序——
// 主进程 SET 有提交耗时，发送入口靠 barrier 保证读到新模型。
describe("#21 e2e：切模型后不等待 UI 反馈立即发送", () => {
  /** 模拟主进程：SET 提交带耗时（真实 IPC + 持久化），提交后会话状态才更新 */
  function makeSlowSession() {
    let session = { id: "s1", modelProfileId: "p-a", model: "glm-old" };
    const ipc = {
      setModelProfile: async () => null,
      setSessionModel: async (_id: string, model: string) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        session = { ...session, model };
        return { ok: true as const, session };
      },
    };
    return { ipc, read: () => session.model };
  }

  it("发送入口 await barrier → 请求装配边界读到的是新模型", async () => {
    const { ipc, read } = makeSlowSession();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated: () => {} });
    let modelAtSend: string | undefined;
    // 真实发送路径：sendMessage 第一件事就是 await barrier()（ChatPage 接线契约）
    const send = async () => {
      await switcher.barrier();
      modelAtSend = read();
    };

    switcher.switchModel("s1", "glm-new"); // 用户切模型，不等任何 UI 反馈
    await send();                          // 立刻 Enter
    expect(modelAtSend).toBe("glm-new");
  });

  it("对照：发送不等 barrier 时读到旧模型（证明屏障不可省）", async () => {
    const { ipc, read } = makeSlowSession();
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated: () => {} });
    let modelAtSend: string | undefined;

    switcher.switchModel("s1", "glm-new");
    modelAtSend = read(); // 不等待：SET 尚未提交
    expect(modelAtSend).toBe("glm-old");

    await switcher.barrier(); // 收尾，避免悬挂定时器
  });

  it("切档案后立即发送同样受屏障保护（原子重置的新模型先落定）", async () => {
    let session = { id: "s1", modelProfileId: "p-a", model: "glm-old" };
    const ipc = {
      setModelProfile: async (_id: string, modelProfileId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        session = { ...session, modelProfileId, model: "glm-b1" }; // 原子重置为新档案默认
        return session;
      },
      setSessionModel: async () => ({ ok: false as const, error: "unused" }),
    };
    const switcher = createSessionModelSwitcher({ ipc, onSessionUpdated: () => {} });
    let modelAtSend: string | undefined;

    switcher.switchProfile("s1", "p-b");
    await (async () => {
      await switcher.barrier();
      modelAtSend = session.model;
    })();
    expect(modelAtSend).toBe("glm-b1");
  });
});
