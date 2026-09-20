// MpvController unit tests — mock child_process + net to avoid real mpv.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MpvController } from "./mpv-controller";

// Mock child_process.spawn
const mockProc = new EventEmitter() as any;
mockProc.stdout = new EventEmitter();
mockProc.stderr = new EventEmitter();
mockProc.kill = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockProc),
  // 模拟 PATH 里没有 mpv：探测命令以非 0 退出
  spawnSync: vi.fn(() => ({ status: 1, error: undefined })),
}));

// Mock net.createConnection — simulates mpv JSON IPC responses.
const mockSocket = new EventEmitter() as any;
mockSocket.write = vi.fn((data: string, cb?: () => void) => {
  if (cb) cb();
  // Parse command and simulate mpv response with matching request_id
  try {
    const msg = JSON.parse(data.trim());
    if (msg.command && msg.request_id != null) {
      const response = JSON.stringify({ request_id: msg.request_id, error: "success", data: null }) + "\n";
      setTimeout(() => mockSocket.emit("data", Buffer.from(response)), 0);
    }
  } catch { /* ignore */ }
  return true;
});
mockSocket.setEncoding = vi.fn();
mockSocket.destroy = vi.fn();
vi.mock("node:net", () => ({
  createConnection: vi.fn((_path: string, onConnect?: () => void) => {
    // Simulate successful connection on next tick
    if (onConnect) setTimeout(() => onConnect(), 0);
    return mockSocket;
  }),
}));

// Mock fs.existsSync for binary detection
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import { createConnection } from "node:net";

beforeEach(() => {
  vi.clearAllMocks();
  mockProc.removeAllListeners();
  mockSocket.removeAllListeners();
  // Re-add write mock after clearAllMocks (simulates mpv JSON IPC responses)
  mockSocket.write = vi.fn((data: string, cb?: () => void) => {
    if (cb) cb();
    try {
      const msg = JSON.parse(data.trim());
      if (msg.command && msg.request_id != null) {
        const response = JSON.stringify({ request_id: msg.request_id, error: "success", data: null }) + "\n";
        setTimeout(() => mockSocket.emit("data", Buffer.from(response)), 0);
      }
    } catch { /* ignore */ }
    return true;
  });
  mockSocket.setEncoding = vi.fn();
  mockSocket.destroy = vi.fn();
  mockProc.kill = vi.fn();
});

describe("MpvController", () => {
  it("start() spawns mpv with --idle and --input-ipc-server", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    expect(spawn).toHaveBeenCalledWith(
      "mpv",
      expect.arrayContaining(["--idle", expect.stringContaining("--input-ipc-server=")]),
      expect.objectContaining({ windowsHide: true }),
    );
    await ctrl.dispose();
  });

  it("isReady() returns true after start", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    expect(ctrl.isReady()).toBe(true);
    await ctrl.dispose();
  });

  it("load(url) sends loadfile command", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    await ctrl.load("http://example.com/song.mp3");
    const written = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string).join("");
    expect(written).toContain("loadfile");
    expect(written).toContain("http://example.com/song.mp3");
    await ctrl.dispose();
  });

  it("load() explicitly unpauses after loadfile (EOF/暂停后换曲无声的回归)", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    await ctrl.load("http://example.com/song.mp3");
    // loadfile 之后的下一条命令必须是 set_property pause=false：
    // loadfile 不重置 pause，keep-open 播完自动暂停后换曲会静默加载
    const calls: string[] = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
    const loadIdx = calls.findIndex((c) => c.includes("loadfile"));
    const unpauseIdx = calls.findIndex((c) => c.includes("set_property") && c.includes("pause") && c.includes("false"));
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(unpauseIdx).toBeGreaterThan(loadIdx);
    await ctrl.dispose();
  });

  it("play/pause/seek/volume send correct mpv commands", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    await ctrl.play();
    await ctrl.pause();
    await ctrl.seek(10);
    await ctrl.setVolume(50);
    const written = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string).join("");
    // 此 mpv 构建的属性赋值必须用 set_property（见 mpv-controller.ts 注释）
    expect(written).toContain('"set_property"');
    expect(written).toContain('"pause"');
    expect(written).toContain('"seek"');
    expect(written).toContain('"volume"');
    await ctrl.dispose();
  });

  it("stop() sends stop command and resets state", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    await ctrl.load("http://example.com/song.mp3");
    await ctrl.stop();
    const state = ctrl.getState();
    expect(state.loaded).toBe(false);
    expect(state.position).toBe(0);
    await ctrl.dispose();
  });

  it("property change events update state", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    // Simulate mpv sending a property-change event
    const dataHandler = mockSocket.listeners("data")[0] as (chunk: Buffer) => void;
    dataHandler(Buffer.from(JSON.stringify({
      event: "property-change",
      name: "time-pos",
      data: 42.5,
    }) + "\n"));
    expect(ctrl.getState().position).toBe(42.5);
    await ctrl.dispose();
  });

  it("pause property change updates paused state", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    const dataHandler = mockSocket.listeners("data")[0] as (chunk: Buffer) => void;
    dataHandler(Buffer.from(JSON.stringify({
      event: "property-change",
      name: "pause",
      data: true,
    }) + "\n"));
    expect(ctrl.getState().paused).toBe(true);
    await ctrl.dispose();
  });

  it("duration property change updates duration state", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    const dataHandler = mockSocket.listeners("data")[0] as (chunk: Buffer) => void;
    dataHandler(Buffer.from(JSON.stringify({
      event: "property-change",
      name: "duration",
      data: 180,
    }) + "\n"));
    expect(ctrl.getState().duration).toBe(180);
    await ctrl.dispose();
  });

  it("onStateChange emits on property updates", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    const listener = vi.fn();
    ctrl.onStateChange(listener);
    const dataHandler = mockSocket.listeners("data")[0] as (chunk: Buffer) => void;
    dataHandler(Buffer.from(JSON.stringify({
      event: "property-change",
      name: "volume",
      data: 80,
    }) + "\n"));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ volume: 80 }));
    await ctrl.dispose();
  });

  it("setTrack attaches metadata to state", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    ctrl.setTrack({ encryptedId: "ABC", name: "晴天", artists: ["周杰伦"] });
    expect(ctrl.getState().track).toEqual({ encryptedId: "ABC", name: "晴天", artists: ["周杰伦"] });
    await ctrl.dispose();
  });

  it("command() rejects when not connected", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await expect(ctrl.command("stop")).rejects.toThrow(/E_MPV_NOT_CONNECTED/);
  });

  it("dispose() cleans up and marks as disposed", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    // Simulate mpv exit so dispose doesn't hang waiting for quit response
    mockProc.emit("exit", 0, null);
    await ctrl.dispose();
    expect(ctrl.isReady()).toBe(false);
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("getState() returns a copy (not internal reference)", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    const s1 = ctrl.getState();
    const s2 = ctrl.getState();
    expect(s1).toEqual(s2);
    s1.volume = 999;
    expect(ctrl.getState().volume).not.toBe(999);
    await ctrl.dispose();
  });

  it("default volume is 70", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    expect(ctrl.getState().volume).toBe(70);
    await ctrl.dispose();
  });

  it("initialVolume option is respected", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv", initialVolume: 30 });
    await ctrl.start();
    expect(ctrl.getState().volume).toBe(30);
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall?.[1]).toContain("--volume=30");
    await ctrl.dispose();
  });

  it("setVolume clamps to 0-100", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    await ctrl.start();
    await ctrl.setVolume(150);
    const written = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string).join("");
    expect(written).toContain("100");
    await ctrl.dispose();
  });

  // ── mpv 缺失回归（issue #98）：探测失败/spawn 失败必须走 reject，
  //    不能变成无监听的 'error' 事件把主进程搞崩 ──

  it("二进制探测失败时 start() 抛 E_MPV_NOT_FOUND（不再裸 spawn 等 ENOENT）", async () => {
    // 不传 binaryPath → detectMpvBinary：固定路径 existsSync=false、PATH 探测失败 → null
    const ctrl = new MpvController();
    await expect(ctrl.start()).rejects.toThrow(/E_MPV_NOT_FOUND/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawn 失败（ENOENT）时 start() reject，而不是未捕获异常崩溃主进程", async () => {
    const ctrl = new MpvController({ binaryPath: "mpv" });
    const pending = ctrl.start();
    // spawn ENOENT：子进程 error 事件异步到达
    mockProc.emit("error", new Error("spawn mpv ENOENT"));
    await expect(pending).rejects.toThrow(/E_MPV_SPAWN_FAILED/);
    // 失败实例要能被 dispose 清理干净（music-service 会这么做）
    await ctrl.dispose();
    expect(ctrl.isReady()).toBe(false);
  });
});
