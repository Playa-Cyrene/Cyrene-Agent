// MpvController — spawn mpv subprocess + JSON IPC control + state events.
//
// Replaces orpheus:// dispatch with direct audio playback via mpv.
// Communicates over a named pipe (Windows) or Unix socket (macOS/Linux)
// using mpv's `--input-ipc-server=<path>` protocol.
//
// Lifecycle:
//   spawn()   → starts mpv in idle mode, waits for IPC socket connect
//   load(url) → loads an audio URL for playback (replaces current)
//   play/pause/seek/volume/stop → mpv commands
//   dispose() → sends quit, waits for exit
//
// State events are emitted on every observed property change
// (time-position, pause, duration, volume, eof-reached).
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { PlaybackState } from "../../shared/music-types";

export type MpvStateListener = (state: PlaybackState) => void;

export interface MpvControllerOptions {
  /** Override mpv binary path (auto-detected if omitted). */
  binaryPath?: string;
  /** Override IPC socket path (temp file by default). */
  socketPath?: string;
  /** Extra args passed to mpv. */
  extraArgs?: string[];
  /** Volume at startup (0–100, default 70). */
  initialVolume?: number;
}

const DEFAULT_VOLUME = 70;
const OBSERVE_PROPS = [
  "time-pos", "pause", "duration", "volume", "eof-reached", "idle-active",
] as const;

export function detectMpvBinary(): string {
  const platform = os.platform();
  if (platform === "win32") {
    // Search order:
    //   1. electron-builder extraResources (packaged)  → process.resourcesPath/bin/mpv/mpv.exe
    //   2. dev-time staged binary                       → <repo>/resources/bin/mpv/mpv.exe
    //   3. system install                               → Program Files\mpv\mpv.exe
    //   4. PATH                                        → mpv
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const candidates = [
      path.join(process.resourcesPath ?? "", "bin", "mpv", "mpv.exe"),
      path.join(repoRoot, "resources", "bin", "mpv", "mpv.exe"),
      path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "mpv", "mpv.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "mpv", "mpv.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "mpv.exe"),
      "mpv", // PATH
    ];
    for (const c of candidates) {
      try {
        if (c === "mpv" || fs.existsSync(c)) {
          console.log("[mpv] detectMpvBinary →", c);
          return c;
        }
      } catch { /* ignore */ }
    }
    console.warn("[mpv] detectMpvBinary: no candidate found, falling back to PATH 'mpv'");
    return "mpv";
  }
  // macOS: Homebrew /opt/homebrew/bin/mpv, /usr/local/bin/mpv
  // Linux: /usr/bin/mpv, /usr/local/bin/mpv
  return "mpv";
}

function defaultSocketPath(): string {
  // Windows: mpv --input-ipc-server 使用命名管道，路径必须是 \\.\pipe\name
  // Unix: 使用 Unix domain socket，放在 /tmp 下
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\mpv-cyrene-${process.pid}-${Date.now()}`;
  }
  const tmp = os.tmpdir();
  const name = `mpv-cyrene-${process.pid}-${Date.now()}.sock`;
  return path.join(tmp, name);
}

export class MpvController extends EventEmitter {
  private proc: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private connected = false;
  private disposed = false;
  private spawnError: Error | null = null;
  private cmdId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private state: PlaybackState = {
    connected: false,
    loaded: false,
    paused: false,
    position: 0,
    duration: 0,
    volume: DEFAULT_VOLUME,
    eofReached: false,
  };
  private readonly options: MpvControllerOptions;
  private readonly socketPath: string;
  private readonly binaryPath: string;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private positionEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private positionDirty = false;

  constructor(options: MpvControllerOptions = {}) {
    super();
    this.options = options;
    this.binaryPath = options.binaryPath ?? detectMpvBinary();
    this.socketPath = options.socketPath ?? defaultSocketPath();
    const vol = options.initialVolume ?? DEFAULT_VOLUME;
    this.state.volume = vol;
  }

  /** Spawn mpv, wait for IPC socket, set up property observers. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("E_MPV_DISPOSED");
    if (this.proc) return; // already started

    // 预检查：detectMpvBinary 可能回退到 PATH 上的裸 "mpv"。对具体路径先验证
    // 存在，避免 spawn 一个必然失败的进程；裸 "mpv"（PATH 解析）无法用
    // existsSync 判断，交给 spawn 的 error 事件兑底。
    if (this.binaryPath !== "mpv" && !fs.existsSync(this.binaryPath)) {
      throw new Error(`E_MPV_NOT_FOUND: ${this.binaryPath}`);
    }

    const args = [
      "--idle",
      `--input-ipc-server=${this.socketPath}`,
      "--no-terminal",
      "--no-video",
      // 播完后停在结尾暂停（不进 idle、track 元数据保留）：
      // eof-reached 属性是"自然播完"的事实源，配合 keep-open 判定 EOF
      "--keep-open=always",
      `--volume=${this.options.initialVolume ?? DEFAULT_VOLUME}`,
      ...(this.options.extraArgs ?? []),
    ];

    this.proc = spawn(this.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.on("exit", (code, signal) => {
      this.connected = false;
      this.state.connected = false;
      this.emitState();
      if (!this.disposed) {
        this.emit("exit", { code, signal });
      }
    });
    this.proc.on("error", (err) => {
      // 关键修复（issue #98）：不再无条件 this.emit("error", …)。
      // EventEmitter 对无监听者的 'error' 事件会抛未捕获异常，直接搞崩 Electron 主进程。
      // 改为记录错误，让 start() 以可诊断的 reject 结束，由上层 music-service try/catch 降级。
      this.spawnError = new Error(`E_MPV_SPAWN_FAILED: ${err.message}`);
      this.connected = false;
      this.state.connected = false;
      if (this.listenerCount("error") > 0) {
        this.emit("error", this.spawnError);
      }
    });

    try {
      await this.connectSocket();
    } catch (err) {
      // spawn 失败优先返回更具体的 E_MPV_SPAWN_FAILED，而非笼统的 socket 超时
      throw this.spawnError ?? err;
    }
  }

  /** Connect to mpv's IPC socket with retry (mpv takes a moment to create it). */
  private connectSocket(retries = 20): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryConnect = (attempt: number) => {
        if (this.disposed || !this.proc) {
          reject(new Error("E_MPV_DISPOSED"));
          return;
        }
        // spawn 已失败（如 ENOENT）：立即以具体错误 reject，不再空转重试 2 秒
        if (this.spawnError) {
          reject(this.spawnError);
          return;
        }
        const sock = net.createConnection(this.socketPath, () => {
          this.socket = sock;
          this.connected = true;
          this.state.connected = true;
          this.setupSocketHandlers();
          this.setupObservers()
            .then(() => {
              this.emitState();
              resolve();
            })
            .catch(reject);
        });
        sock.on("error", () => {
          if (attempt < retries) {
            setTimeout(() => tryConnect(attempt + 1), 100);
          } else {
            reject(new Error("E_MPV_SOCKET_CONNECT_FAILED"));
          }
        });
      };
      tryConnect(0);
    });
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;
    let buffer = "";
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        this.handleMessage(line);
      }
    });
    this.socket.on("close", () => {
      this.connected = false;
      this.state.connected = false;
      this.emitState();
    });
  }

  private handleMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Command response
    if (msg.request_id != null) {
      const pending = this.pending.get(msg.request_id);
      if (pending) {
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== "success") {
          pending.reject(new Error(`E_MPV_CMD: ${msg.error}`));
        } else {
          pending.resolve(msg.data);
        }
      }
      return;
    }
    // Property change event
    if (msg.event === "property-change") {
      this.applyPropertyChange(msg.name, msg.data);
    }
  }

  private applyPropertyChange(name: string, value: unknown): void {
    switch (name) {
      case "time-pos":
        // time-pos 每秒更新多次，节流到 500ms 一次，避免 IPC 刷屏
        this.state.position = typeof value === "number" ? value : 0;
        this.positionDirty = true;
        if (!this.positionEmitTimer) {
          this.positionEmitTimer = setTimeout(() => {
            this.positionEmitTimer = null;
            if (this.positionDirty) {
              this.positionDirty = false;
              this.emitState();
            }
          }, 500);
        }
        return; // 不走下面的 emitState
      case "pause":
        this.state.paused = value === true;
        break;
      case "duration":
        this.state.duration = typeof value === "number" ? value : 0;
        break;
      case "volume":
        this.state.volume = typeof value === "number" ? value : 0;
        break;
      case "eof-reached":
        // keep-open 下播完 mpv 停在结尾（position 保留、track 元数据保留），
        // eofReached 作为"自然播完"事实源推给前端做模式路由
        this.state.eofReached = value === true;
        break;
      case "idle-active":
        this.state.loaded = value === false;
        break;
    }
    this.emitState();
  }

  private async setupObservers(): Promise<void> {
    for (const prop of OBSERVE_PROPS) {
      await this.command("observe_property", [Math.floor(Math.random() * 1e6), prop]);
    }
  }

  /** Send a command to mpv and await its response. */
  command(command: string, args: unknown[] = []): Promise<unknown> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error("E_MPV_NOT_CONNECTED"));
    }
    const id = ++this.cmdId;
    const payload = JSON.stringify({ command: [command, ...args], request_id: id }) + "\n";
    const cmdLabel = `${command} ${JSON.stringify(args)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject: (err: Error) => reject(new Error(`${err.message} [cmd: ${cmdLabel}]`)),
      });
      this.socket!.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`E_MPV_WRITE: ${err.message}`));
        }
      });
      // Timeout: 5s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("E_MPV_CMD_TIMEOUT"));
        }
      }, 5000);
    });
  }

  /** Load a URL for playback (replaces current, starts playing). */
  async load(url: string, mode: "replace" | "append" = "replace"): Promise<void> {
    // 清除上一首的 track 元数据：loadfile 期间 mpv 会推送多次 property change
    // （time-pos/duration/idle-active），若此时 state.track 还是旧值，前端会
    // 用旧 track 去 queue 匹配，导致 UI 跳回第一首。setTrack 会随后注入新 track。
    this.state.track = undefined;
    this.state.eofReached = false;
    this.emitState();
    await this.command("loadfile", [url, mode]);
    // loadfile 不会重置 pause 标志：上一曲暂停/EOF（keep-open 播完自动 pause）
    // 状态下换曲会"加载了但无声、进度条不动"。必须显式解除暂停。
    // （实测 mpv v0.41：EOF 后 loadfile 仍保持 pause=true，time-pos 停在 0）
    await this.command("set_property", ["pause", false]);
    this.state.loaded = true;
    this.state.paused = false;
    this.state.eofReached = false;
    this.emitState();
  }

  /** Attach track metadata to the current playback state. */
  setTrack(track: PlaybackState["track"]): void {
    this.state.track = track;
    this.emitState();
  }

  // 注：此 mpv 构建（v0.41 dev）的 `set` 命令拒绝 JSON 数字/布尔值（报 invalid parameter），
  // 属性赋值必须用 `set_property`。
  async play(): Promise<void> { await this.command("set_property", ["pause", false]); }
  async pause(): Promise<void> { await this.command("set_property", ["pause", true]); }
  async togglePlay(): Promise<void> { await this.command("cycle", ["pause"]); }
  async seek(seconds: number, mode: "relative" | "absolute" = "relative"): Promise<void> {
    await this.command("seek", [seconds, mode]);
  }
  async setVolume(vol: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, vol));
    await this.command("set_property", ["volume", clamped]);
  }
  async stop(): Promise<void> {
    await this.command("stop");
    this.state.loaded = false;
    this.state.position = 0;
    this.state.eofReached = false;
    this.emitState();
  }

  /** Next/prev require a playlist queue (M4 integration with MusicService). */
  async next(): Promise<void> { await this.command("playlist-next", ["weak"]); }
  async prev(): Promise<void> { await this.command("playlist-prev", ["weak"]); }

  getState(): PlaybackState {
    return { ...this.state, track: this.state.track ? { ...this.state.track } : undefined };
  }

  isReady(): boolean {
    return this.connected && !this.disposed;
  }

  onStateChange(listener: MpvStateListener): () => void {
    this.on("state", listener);
    return () => this.off("state", listener);
  }

  private emitState(): void {
    this.emit("state", this.getState());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
    }
    if (this.positionEmitTimer) {
      clearTimeout(this.positionEmitTimer);
      this.positionEmitTimer = null;
    }
    // Reject pending commands
    for (const [, p] of this.pending) p.reject(new Error("E_MPV_DISPOSED"));
    this.pending.clear();
    // Try graceful quit
    if (this.socket && this.connected) {
      try { await this.command("quit"); } catch { /* ignore */ }
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      this.proc = null;
    }
    // Clean up socket file
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }
}
