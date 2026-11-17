import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHelperClient, type ComputerHelperChildProcess } from "./helper-client";

type Listener = (...args: unknown[]) => void;

class FakeChild implements ComputerHelperChildProcess {
  readonly written: Array<Record<string, unknown>> = [];
  readonly kill = vi.fn();
  private readonly stdoutListeners: Listener[] = [];
  private readonly processListeners = new Map<string, Listener[]>();

  stdin = {
    write: (line: string): boolean => {
      this.written.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
  };
  stdout = { on: (_event: "data", listener: Listener) => this.stdoutListeners.push(listener) };

  on(event: "error" | "exit", listener: Listener): void {
    this.processListeners.set(event, [...(this.processListeners.get(event) ?? []), listener]);
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of this.stdoutListeners) listener(`${JSON.stringify(event)}\n`);
  }

  exit(code: number): void {
    for (const listener of this.processListeners.get("exit") ?? []) listener(code);
  }
}

function setup(requestTimeoutMs?: number) {
  const children: FakeChild[] = [];
  const spawnArgs: string[][] = [];
  let nextId = 0;
  const client = new ComputerHelperClient({
    spawnImpl: (_command, args) => {
      spawnArgs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    resolveHelperPath: () => "helper.exe",
    outputDirectory: "C:\\out",
    parentProcessId: 42,
    createRequestId: () => `r${++nextId}`,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  });
  /** 等待微任务推进到命令写出。 */
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return { client, children, spawnArgs, flush };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ComputerHelperClient", () => {
  it("首次调用才启动 helper，并在 ready 之后发送命令", async () => {
    const { client, children, spawnArgs, flush } = setup();
    expect(children).toHaveLength(0);

    const pending = client.screenshot(1568);
    await flush();
    expect(spawnArgs).toEqual([["--output-dir", "C:\\out", "--protocol-version", "1", "--parent-pid", "42"]]);
    expect(children[0].written).toEqual([]);

    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();
    expect(children[0].written).toEqual([{ type: "screenshot", maxEdge: 1568, id: "r1" }]);

    children[0].emit({ type: "screenshot-result", id: "r1", fileName: "shot-1-1.png", width: 1568, height: 882, screenWidth: 2560, screenHeight: 1440 });
    await expect(pending).resolves.toEqual({ fileName: "shot-1-1.png", width: 1568, height: 882, screenWidth: 2560, screenHeight: 1440 });
  });

  it("拒绝不符合约定的截图文件名", async () => {
    const { client, children, flush } = setup();
    const pending = client.screenshot(1568);
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();

    children[0].emit({ type: "screenshot-result", id: "r1", fileName: "..\\..\\evil.png", width: 1, height: 1, screenWidth: 1, screenHeight: 1 });

    await expect(pending).rejects.toMatchObject({ code: "INVALID_SCREENSHOT_FILE_NAME" });
  });

  it("把 helper 的结构化错误按 code 透传", async () => {
    const { client, children, flush } = setup();
    const pending = client.click({ x: 1, y: 2, spaceWidth: 10, spaceHeight: 10, button: "left", count: 1 });
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();

    children[0].emit({ type: "error", id: "r1", code: "ELEVATED_TARGET", message: "elevated" });

    await expect(pending).rejects.toMatchObject({ code: "ELEVATED_TARGET" });
  });

  it("协议版本不一致时拒绝使用并结束进程", async () => {
    const { client, children, flush } = setup();
    const pending = client.typeText("hi");
    await flush();

    children[0].emit({ type: "ready", protocolVersion: 2 });

    await expect(pending).rejects.toMatchObject({ code: "INCOMPATIBLE_HELPER_PROTOCOL" });
    expect(children[0].kill).toHaveBeenCalled();
    expect(children[0].written).toEqual([]);
  });

  it("helper 中途退出时让未完成的请求失败，下次调用重新拉起", async () => {
    const { client, children, flush } = setup();
    const first = client.typeText("a");
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();

    children[0].exit(1);
    await expect(first).rejects.toMatchObject({ code: "HELPER_EXITED" });

    const second = client.typeText("b");
    await flush();
    expect(children).toHaveLength(2);
    children[1].emit({ type: "ready", protocolVersion: 1 });
    await flush();
    children[1].emit({ type: "done", id: "r2" });
    await expect(second).resolves.toBeUndefined();
  });

  it("已被替换的旧进程的迟到退出事件不影响新进程", async () => {
    const { client, children, flush } = setup();
    const first = client.typeText("a");
    await flush();
    children[0].exit(1);
    await expect(first).rejects.toBeDefined();

    const second = client.typeText("b");
    await flush();
    children[1].emit({ type: "ready", protocolVersion: 1 });
    await flush();
    children[0].exit(1);
    children[1].emit({ type: "done", id: "r1" });

    await expect(second).resolves.toBeUndefined();
  });

  it("请求超时后结束 helper，不复用状态未知的进程", async () => {
    vi.useFakeTimers();
    const { client, children } = setup(1000);
    const pending = client.typeText("slow");
    const settled = expect(pending).rejects.toMatchObject({ code: "HELPER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(0);
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1000);

    await settled;
    expect(children[0].kill).toHaveBeenCalled();
    expect(client.isRunning).toBe(false);
  });

  it("shutdown 发送退出命令并结束进程", async () => {
    const { client, children, flush } = setup();
    const pending = client.typeText("a");
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();

    client.shutdown();

    await expect(pending).rejects.toMatchObject({ code: "HELPER_STOPPED" });
    expect(children[0].written.at(-1)).toEqual({ type: "shutdown" });
    expect(children[0].kill).toHaveBeenCalled();
  });
  it("滚动命令带上截图参照系，字段与 Rust 侧一致", async () => {
    const { client, children, flush } = setup();
    const pending = client.scroll({ x: 5, y: 6, spaceWidth: 1568, spaceHeight: 882, direction: "down", amount: 3 });
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();
    expect(children[0].written.at(-1)).toEqual({
      type: "scroll", id: "r1", x: 5, y: 6, spaceWidth: 1568, spaceHeight: 882, direction: "down", amount: 3,
    });
    children[0].emit({ type: "done", id: "r1" });
    await expect(pending).resolves.toBeUndefined();
  });

  it("急停让正在执行的命令以 EMERGENCY_STOP 失败并结束进程", async () => {
    const { client, children, flush } = setup();
    const pending = client.typeText("很长的一段文本");
    await flush();
    children[0].emit({ type: "ready", protocolVersion: 1 });
    await flush();

    client.shutdown("EMERGENCY_STOP");

    await expect(pending).rejects.toMatchObject({ code: "EMERGENCY_STOP" });
    expect(children[0].kill).toHaveBeenCalled();
  });
});
