import { randomUUID } from "node:crypto";
import {
  COMPUTER_HELPER_PROTOCOL_VERSION,
  parseComputerHelperEvent,
  type ComputerHelperCommand,
  type ComputerHelperEvent,
  type ComputerScrollDirection,
} from "./protocol";

type DataListener = (chunk: Buffer | string) => void;
type ProcessListener = (...args: unknown[]) => void;

export interface ComputerHelperChildProcess {
  stdin: {
    write(line: string): boolean;
    on?(event: "error", listener: (error: Error) => void): unknown;
    readonly destroyed?: boolean;
  };
  stdout: { on(event: "data", listener: DataListener): unknown };
  stderr?: { on(event: "data", listener: DataListener): unknown };
  on(event: "error" | "exit", listener: ProcessListener): unknown;
  kill?(): unknown;
}

export interface ComputerHelperClientOptions {
  spawnImpl(command: string, args: string[]): ComputerHelperChildProcess;
  resolveHelperPath(): string;
  outputDirectory: string;
  parentProcessId?: number;
  /** 单条命令的超时；helper 卡死时不能让工具调用无限挂起。 */
  requestTimeoutMs?: number;
  createRequestId?: () => string;
  logger?: Pick<Console, "debug" | "warn">;
}

export interface ComputerScreenshot {
  fileName: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

/** helper 返回的结构化失败；code 稳定，供工具层映射成给模型的提示。 */
export class ComputerHelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ComputerHelperError";
  }
}

type RequestCommand = Exclude<ComputerHelperCommand, { type: "shutdown" }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Reply = Extract<ComputerHelperEvent, { type: "screenshot-result" | "done" }>;

interface Pending {
  resolve(event: Reply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const SCREENSHOT_FILE_NAME = /^shot-\d{1,20}-\d{1,10}\.png$/;

export class ComputerHelperClient {
  private child: ComputerHelperChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private settleReady: { resolve(): void; reject(error: Error): void } | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: ComputerHelperClientOptions) {}

  get isRunning(): boolean {
    return this.child !== null;
  }

  async screenshot(maxEdge: number): Promise<ComputerScreenshot> {
    const event = await this.request({ type: "screenshot", maxEdge });
    if (event.type !== "screenshot-result") throw new ComputerHelperError("UNEXPECTED_REPLY", event.type);
    // 文件名随后会拼进路径并写入会话轨迹，这里就拒绝不符合约定的值。
    if (!SCREENSHOT_FILE_NAME.test(event.fileName)) {
      throw new ComputerHelperError("INVALID_SCREENSHOT_FILE_NAME", event.fileName);
    }
    const { fileName, width, height, screenWidth, screenHeight } = event;
    return { fileName, width, height, screenWidth, screenHeight };
  }

  async click(input: { x: number; y: number; spaceWidth: number; spaceHeight: number; button: "left" | "right"; count: 1 | 2 }): Promise<void> {
    await this.request({ type: "click", ...input });
  }

  async typeText(text: string): Promise<void> {
    await this.request({ type: "type-text", text });
  }

  async scroll(input: { x: number; y: number; spaceWidth: number; spaceHeight: number; direction: ComputerScrollDirection; amount: number }): Promise<void> {
    await this.request({ type: "scroll", ...input });
  }

  /**
   * 让 helper 退出；未完成的请求全部以 `code` 失败，之后的调用会重新拉起进程。
   * 急停也走这里：直接结束进程，正在分批注入的文本不会再继续输入。
   */
  shutdown(code = "HELPER_STOPPED"): void {
    const child = this.child;
    if (!child) return;
    this.write({ type: "shutdown" });
    this.handleExit(new ComputerHelperError(code, ""));
    // shutdown 命令可能因管道已断而送不到；helper 能注入输入，不能留下无人管理的进程。
    try {
      child.kill?.();
    } catch {
      // 进程已退出时 kill 抛错无需处理。
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.stdoutBuffer = "";
    const ready = new Promise<void>((resolve, reject) => {
      this.settleReady = { resolve, reject };
    });
    this.ready = ready;
    try {
      const child = this.options.spawnImpl(this.options.resolveHelperPath(), [
        "--output-dir", this.options.outputDirectory,
        "--protocol-version", String(COMPUTER_HELPER_PROTOCOL_VERSION),
        "--parent-pid", String(this.options.parentProcessId ?? process.pid),
      ]);
      this.child = child;
      const exited = (error: Error): void => {
        // 旧进程的迟到事件不能清掉已经重新拉起的新进程。
        if (this.child === child) this.handleExit(error);
      };
      // helper 先于主进程退出时，stdin 上的异步 EPIPE 没有监听器会升级成 uncaughtException。
      child.stdin.on?.("error", (error) => this.options.logger?.debug("[ComputerHelper] stdin 写入失败:", error));
      child.stdout.on("data", (chunk) => {
        if (this.child === child) this.handleStdout(chunk.toString());
      });
      child.stderr?.on("data", (chunk) => this.options.logger?.debug("[ComputerHelper stderr]", chunk.toString()));
      child.on("error", (error) => exited(error instanceof Error ? error : new ComputerHelperError("HELPER_PROCESS_ERROR", "")));
      child.on("exit", (code) => exited(new ComputerHelperError("HELPER_EXITED", typeof code === "number" ? String(code) : "")));
    } catch (error) {
      this.handleExit(error instanceof Error ? error : new ComputerHelperError("HELPER_START_FAILED", ""));
    }
    return ready;
  }

  private async request(command: DistributiveOmit<RequestCommand, "id">): Promise<Reply> {
    await this.ensureStarted();
    const id = (this.options.createRequestId ?? randomUUID)();
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时后 helper 的状态未知（输入可能只注入了一半），直接重启比继续复用更安全。
        this.shutdown();
        reject(new ComputerHelperError("HELPER_TIMEOUT", command.type));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...command, id } as RequestCommand);
    });
  }

  private write(command: ComputerHelperCommand): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.options.logger?.debug("[ComputerHelper] 写入命令失败:", error);
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          this.handleEvent(parseComputerHelperEvent(line));
        } catch (error) {
          this.options.logger?.warn("[ComputerHelper] 忽略无法解析的事件", error);
        }
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleEvent(event: ComputerHelperEvent): void {
    if (event.type === "ready") {
      if (event.protocolVersion !== COMPUTER_HELPER_PROTOCOL_VERSION) {
        const child = this.child;
        this.handleExit(new ComputerHelperError("INCOMPATIBLE_HELPER_PROTOCOL", String(event.protocolVersion)));
        child?.kill?.();
        return;
      }
      this.settleReady?.resolve();
      this.settleReady = null;
      return;
    }
    if (event.type === "error" && event.id === undefined) {
      this.options.logger?.warn("[ComputerHelper]", event.code, event.message);
      return;
    }
    if (event.id === undefined) return;
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    clearTimeout(pending.timer);
    if (event.type === "error") pending.reject(new ComputerHelperError(event.code, event.message));
    else pending.resolve(event);
  }

  private handleExit(error: Error): void {
    this.child = null;
    this.ready = null;
    this.settleReady?.reject(error);
    this.settleReady = null;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
