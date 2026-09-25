import { describe, expect, it, vi } from "vitest";
import { createWindowActivationBroker } from "./window-activation";

describe("createWindowActivationBroker", () => {
  it("queues and coalesces activation until markReady", async () => {
    const activate = vi.fn();
    const focusLoading = vi.fn();
    const broker = createWindowActivationBroker();
    broker.bind({ activate, focusLoading });
    broker.request({ kind: "chat", sessionId: "old" });
    broker.request({ kind: "chat", sessionId: "new" });
    expect(activate).not.toHaveBeenCalled();
    expect(focusLoading).toHaveBeenCalledTimes(2);
    await broker.markReady();
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith({ kind: "chat", sessionId: "new" });
  });

  it("rejects activation after stop", () => {
    const broker = createWindowActivationBroker();
    broker.stop();
    broker.request({ kind: "chat" });
    expect(broker.isReady()).toBe(false);
  });

  it("keeps requests of different kinds pending independently", async () => {
    const activate = vi.fn();
    const broker = createWindowActivationBroker();
    broker.bind({ activate, focusLoading: vi.fn() });
    broker.request({ kind: "chat", sessionId: "s1" });
    broker.request({ kind: "settings", section: "model" });
    broker.request({ kind: "music" });
    await broker.markReady();
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it("activates directly without focusLoading once ready", async () => {
    const activate = vi.fn();
    const focusLoading = vi.fn();
    const broker = createWindowActivationBroker();
    broker.bind({ activate, focusLoading });
    broker.request({ kind: "chat" });
    focusLoading.mockClear();
    await broker.markReady();
    broker.request({ kind: "music" });
    await new Promise((resolve) => setTimeout(resolve, 0)); // dispatch 走微任务，先 flush
    expect(focusLoading).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenNthCalledWith(2, { kind: "music" });
  });

  it("drains pending requests only once across repeated markReady", async () => {
    const activate = vi.fn();
    const broker = createWindowActivationBroker();
    broker.bind({ activate, focusLoading: vi.fn() });
    broker.request({ kind: "chat" });
    await broker.markReady();
    await broker.markReady();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("queues requests before bind without crashing and focuses loading after bind", () => {
    const activate = vi.fn();
    const focusLoading = vi.fn();
    const broker = createWindowActivationBroker();
    broker.request({ kind: "chat" }); // 未 bind：先排队，不崩
    broker.bind({ activate, focusLoading });
    broker.request({ kind: "settings" });
    expect(focusLoading).toHaveBeenCalledOnce();
  });

  it("ignores requests after stop instead of queueing them", async () => {
    const activate = vi.fn();
    const focusLoading = vi.fn();
    const broker = createWindowActivationBroker();
    broker.bind({ activate, focusLoading });
    broker.stop();
    broker.request({ kind: "chat" });
    await broker.markReady();
    expect(focusLoading).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
