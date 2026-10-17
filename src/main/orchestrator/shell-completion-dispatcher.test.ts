import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellCompletionDispatcher, type ShellCompletion } from "./shell-completion-dispatcher";

const completion = (conversationId = "original", jobId = "job-1", signal?: AbortSignal): ShellCompletion => ({
  conversationId, sourceRunId: "source-run", signal,
  snapshot: { jobId, pid: null, status: "exited", exitCode: 0, reason: null, totalBytes: 4,
    logFile: "fixture.log", command: "fixture", shell: "cmd", startedAt: "2026-01-01T00:00:00Z", durationMs: 5, tail: "done" },
});
const dispatchers: ShellCompletionDispatcher[] = [];
function setup(busy = false) {
  const deps = { append: vi.fn(async () => {}), isBusy: vi.fn(() => busy), wake: vi.fn(async (_id: string, _job: string) => {}), onError: vi.fn() };
  const dispatcher = new ShellCompletionDispatcher(deps);
  dispatchers.push(dispatcher);
  return { dispatcher, deps };
}
afterEach(async () => { for (const dispatcher of dispatchers.splice(0)) await dispatcher.dispose(); vi.useRealTimers(); });

describe("shell completion inbox", () => {
  it.each([false, true])("keeps overlapping mutation suspensions independent (commit=%s)", async commit => {
    const { dispatcher, deps } = setup();
    const first = dispatcher.suspendWake("original");
    const second = dispatcher.suspendWake("original");
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    first(); first();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(dispatcher.canWake("original")).toBe(false);
    expect(deps.wake).not.toHaveBeenCalled();
    second(commit);
    if (commit) {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(deps.wake).not.toHaveBeenCalled();
    } else await expect.poll(() => deps.wake.mock.calls.length).toBe(1);
  });

  it("rolling back a mutation cannot clear a concurrent user cancellation", async () => {
    const { dispatcher, deps } = setup();
    const release = dispatcher.suspendWake("original");
    dispatcher.suppressWake("original");
    release();
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(dispatcher.canWake("original")).toBe(false);
  });
  it("acknowledges only the prepared context and retains events arriving during preparation", async () => {
    const { dispatcher, deps } = setup(true);
    const saved: import("./vendors/types").ChatMessage[] = [];
    deps.append.mockImplementation(async (...args: unknown[]) => { saved.push(args[1] as typeof saved[number]); });
    dispatcher.enqueue(completion());
    await expect.poll(() => saved.length).toBe(1);
    const included = new Set([saved[0].internal!.id]);
    dispatcher.enqueue(completion("original", "job-2"));
    await expect.poll(() => saved.length).toBe(2);
    dispatcher.acknowledge("original", included);
    expect(await dispatcher.take("original")).toEqual([saved[1]]);
    expect(dispatcher.canWake("original")).toBe(false);
  });
  it("persists once and wakes the originating idle conversation without a waiter", async () => {
    const { dispatcher, deps } = setup();
    deps.wake.mockImplementation(async id => { await dispatcher.take(id); });
    dispatcher.enqueue(completion());
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.wake.mock.calls.length).toBe(1);
    expect(deps.wake).toHaveBeenCalledWith("original", "job-1", expect.objectContaining({ sourceRunId: "source-run" }));
    expect(deps.append).toHaveBeenCalledTimes(1);
    expect(deps.append.mock.invocationCallOrder[0]).toBeLessThan(deps.wake.mock.invocationCallOrder[0]);
    expect(await dispatcher.take("original")).toEqual([]);
  });

  it("busy conversations consume durable internal facts once; other conversations cannot consume them", async () => {
    const { dispatcher, deps } = setup(true);
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(await dispatcher.take("different")).toEqual([]);
    const messages = await dispatcher.take("original");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ visibility: "internal", content: expect.stringContaining('"exitCode":0') });
    expect(await dispatcher.take("original")).toEqual([]);
  });

  it("kicks a late completion after a busy run releases its guard", async () => {
    const { dispatcher, deps } = setup(true);
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    deps.isBusy.mockReturnValue(false);
    dispatcher.kick("original");
    await expect.poll(() => deps.wake.mock.calls.length).toBe(1);
  });

  it("cancelled owners keep their result but never automatically wake", async () => {
    const { dispatcher, deps } = setup();
    const controller = new AbortController();
    dispatcher.enqueue(completion("original", "job-1", controller.signal));
    controller.abort();
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("retains failed persistence and retries without dispatching an uncommitted fact", async () => {
    vi.useFakeTimers();
    const { dispatcher, deps } = setup();
    deps.append.mockRejectedValueOnce(new Error("disk unavailable"));
    dispatcher.enqueue(completion());
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.append).toHaveBeenCalledTimes(2);
    expect(deps.wake).toHaveBeenCalledTimes(1);
  });

  it("cancelling the conversation also suppresses jobs launched by older runs, until an explicit new run", async () => {
    const { dispatcher, deps } = setup();
    dispatcher.suppressWake("original");
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    expect(deps.wake).not.toHaveBeenCalled();
    dispatcher.resume("original");
    dispatcher.enqueue(completion("original", "new-job"));
    await expect.poll(() => deps.wake.mock.calls.length).toBe(1);
    expect(deps.wake).toHaveBeenCalledWith("original", "new-job", expect.objectContaining({ sourceRunId: "source-run" }));
  });

  it("shutdown drains an in-flight write and suppresses wake/retry", async () => {
    const { dispatcher, deps } = setup();
    let finish!: () => void;
    deps.append.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    dispatcher.enqueue(completion());
    await expect.poll(() => deps.append.mock.calls.length).toBe(1);
    dispatcher.enqueue(completion("original", "job-2"));
    dispatcher.enqueue(completion("other", "job-3"));
    let disposed = false;
    const stopping = dispatcher.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finish();
    await stopping;
    expect(deps.append).toHaveBeenCalledTimes(3);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("persists queued events when disposed before the first timer fires", async () => {
    vi.useFakeTimers();
    const { dispatcher, deps } = setup();
    dispatcher.enqueue(completion());
    dispatcher.enqueue(completion("original", "job-2"));
    await dispatcher.dispose();
    expect(deps.append).toHaveBeenCalledTimes(2);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains failed shutdown writes for an explicit retry and reports failure", async () => {
    const { dispatcher, deps } = setup();
    deps.append.mockRejectedValueOnce(new Error("disk unavailable"));
    dispatcher.enqueue(completion());
    await expect(dispatcher.dispose()).rejects.toThrow("后台任务结束事件保存失败");
    await dispatcher.dispose();
    expect(deps.append).toHaveBeenCalledTimes(2);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("persists mismatched workspaces without injecting them or dropping matching events", async () => {
    const append = vi.fn(async () => {});
    const dispatcher = new ShellCompletionDispatcher({ append, isBusy: () => true, wake: vi.fn(), onError: vi.fn(),
      canDeliver: async event => event.sourceWorkspace === "B" });
    dispatchers.push(dispatcher);
    dispatcher.enqueue({ ...completion(), sourceWorkspace: "A" });
    dispatcher.enqueue({ ...completion("original", "job-2"), sourceWorkspace: "B" });
    const messages = await dispatcher.take("original");
    expect(append).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('"jobId":"job-2"');
  });

  it("persists retirement when shutdown saves a queued completion after a workspace rebind", async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const retire = vi.fn();
    const wake = vi.fn();
    const dispatcher = new ShellCompletionDispatcher({
      append, retire, isBusy: () => false, wake, onError: vi.fn(), canDeliver: async () => false,
    });
    dispatchers.push(dispatcher);
    const event = { ...completion(), sourceWorkspace: "A" };
    dispatcher.enqueue(event);
    await dispatcher.dispose();
    expect(append).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(event);
    expect(wake).not.toHaveBeenCalled();
  });

  it("persists retirement before removing a saved event and retries failed retirement", async () => {
    vi.useFakeTimers();
    let workspace = "A";
    const retire = vi.fn(async () => {});
    retire.mockRejectedValueOnce(new Error("retirement unavailable"));
    const wake = vi.fn();
    const onError = vi.fn();
    const dispatcher = new ShellCompletionDispatcher({
      append: vi.fn(), retire, isBusy: () => true, wake, onError,
      canDeliver: async event => event.sourceWorkspace === workspace,
    });
    dispatchers.push(dispatcher);
    const event = { ...completion(), sourceWorkspace: "A" };
    dispatcher.enqueue(event);
    await vi.advanceTimersByTimeAsync(1);
    workspace = "B";
    dispatcher.kick("original");
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(dispatcher.canWake("original")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenLastCalledWith(event);
    expect(dispatcher.canWake("original")).toBe(false);
    expect(await dispatcher.take("original")).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("persists events arriving during workspace validation before waking them", async () => {
    const saved: string[] = [];
    const wake = vi.fn(async (id: string) => {
      expect(saved).toEqual(["job-1", "job-2"]);
      await dispatcher.take(id);
    });
    const dispatcher = new ShellCompletionDispatcher({
      append: async event => { saved.push(event.snapshot.jobId); }, isBusy: () => false, wake, onError: vi.fn(),
      canDeliver: async event => {
        if (event.snapshot.jobId === "job-1") {
          dispatcher.enqueue(completion("original", "job-2"));
          return false;
        }
        return true;
      },
    });
    dispatchers.push(dispatcher);
    dispatcher.enqueue(completion());
    await expect.poll(() => wake.mock.calls.length).toBe(1);
    expect(saved).toEqual(["job-1", "job-2"]);
  });
});
