// 回归测试：mpv 启动失败之后必须还能重试。
//
// 背景：startMpv() 为了幂等加了早退守卫（否则没有网易云凭据时，每次音乐操作
// 都会重跑 initOpenapi 并 new 一个 MpvController，把注册在旧实例上的监听器
// 丢掉——表现为「歌能放但进度条不动」，还会堆积 mpv 进程）。
//
// 但守卫如果写成「对象存在就早退」，就会踩到另一条路径：
//   1. 无凭据时首次 start() → mpv 启动失败（开发环境没跑 prepare:mpv 时必现）
//   2. 失败实例残留在 this.mpv 上
//   3. 用户补配网易云凭据 → applyOpenapiConfig → start() → 守卫早退
//   4. backendState 变 "ready"，但 mpv 从未运行 → 配好了也放不了歌，
//      且不重启应用永远无法自愈
//
// 所以守卫必须是 isReady()，且 catch 里要把失败实例清空。
import { describe, it, expect, beforeEach, vi } from "vitest";

// mock 的实现一律用 function 而不是箭头函数：这些都要被 new 调用，
// 箭头函数不能当构造器（会报 "is not a constructor"）。
const mpvState = vi.hoisted(() => ({
  /** 每次 new MpvController() 都记一笔，用来判断是否真的重试了。 */
  instances: 0,
  /** 下一次 start() 是否失败。 */
  failNext: false,
  started: 0,
  disposed: 0,
}));

vi.mock("./mpv-controller", () => ({
  MpvController: vi.fn().mockImplementation(function () {
    mpvState.instances += 1;
    let ready = false;
    return {
      start: vi.fn(async () => {
        mpvState.started += 1;
        if (mpvState.failNext) throw new Error("E_MPV_NOT_FOUND");
        ready = true;
      }),
      dispose: vi.fn(async () => { mpvState.disposed += 1; ready = false; }),
      isReady: vi.fn(() => ready),
      onStateChange: vi.fn(() => () => {}),
      setTrack: vi.fn(),
      load: vi.fn(async () => {}),
      getState: vi.fn(() => ({
        connected: ready, loaded: false, paused: false,
        position: 0, duration: 0, volume: 70,
      })),
    };
  }),
}));

// 凭据：初始为空，save() 之后才有
const configState = vi.hoisted(() => ({
  saved: null as { appId: string; privateKey: string } | null,
}));

vi.mock("./openapi-config", () => ({
  OpenapiConfigStore: vi.fn().mockImplementation(function () {
    return {
      loadValidated: vi.fn(async () => configState.saved),
      load: vi.fn(async () => configState.saved),
      save: vi.fn(async (cfg: { appId: string; privateKey: string }) => { configState.saved = cfg; }),
      delete: vi.fn(async () => { configState.saved = null; }),
    };
  }),
  validateOpenapiConfig: vi.fn(),
}));

vi.mock("./token-vault", () => ({
  TokenVault: vi.fn().mockImplementation(function () {
    return {
      load: vi.fn(async () => null),
      persist: vi.fn(async () => true),
      delete: vi.fn(async () => {}),
      decrypt: vi.fn(async () => ({ accessToken: "", refreshToken: "", expireTime: 0, gotAt: 0 })),
      isFresh: vi.fn(() => false),
    };
  }),
}));

vi.mock("./openapi-login-orchestrator", () => ({
  OpenapiLoginOrchestrator: vi.fn().mockImplementation(function () {
    return {
      restoreSession: vi.fn(async () => false),
      getAccountState: vi.fn(() => "signed_out"),
      getFlowState: vi.fn(() => "idle"),
      getProfile: vi.fn(() => null),
      shutdown: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("./cache-downloader", () => ({
  CacheDownloader: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn(async () => {}),
      getFilePath: vi.fn(() => null),
      getDownloadPromise: vi.fn(() => null),
      getTrack: vi.fn(() => null),
      onUpdated: vi.fn(() => () => {}),
      download: vi.fn(async () => {}),
      importFiles: vi.fn(async () => ({ imported: 0, skipped: 0 })),
    };
  }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cyrene-mpv-retry", isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { MusicService } from "./music-service";

function service(): MusicService {
  return new MusicService({
    runtimeDir: "/tmp/cyrene-mpv-retry/runtime",
    accountPath: "/tmp/cyrene-mpv-retry/music/netease/account.enc",
    resourceBaseDir: "/tmp/cyrene-mpv-retry",
  });
}

beforeEach(() => {
  mpvState.instances = 0;
  mpvState.failNext = false;
  mpvState.started = 0;
  mpvState.disposed = 0;
  configState.saved = null;
});

describe("startMpv 失败后可重试", () => {
  it("无凭据时也会尝试启动 mpv（本地音乐要用）", async () => {
    const svc = service();
    await svc.start();

    expect(mpvState.started).toBe(1);
    expect(svc.getPlayerState()).toBe("available");
  });

  it("启动失败后补配凭据，mpv 仍然能起来（回归：守卫曾把重试挡掉）", async () => {
    mpvState.failNext = true;

    const svc = service();
    await svc.start();                       // 无凭据 + mpv 起不来
    expect(mpvState.started).toBe(1);
    expect(svc.getPlayerState()).toBe("unavailable");

    // 环境修好了（比如用户跑了 prepare:mpv），再补上凭据
    mpvState.failNext = false;
    await svc.applyOpenapiConfig({ appId: "app", privateKey: "K".repeat(1600) });

    // 关键：必须真的又 new 了一个实例并重新 start，而不是被守卫早退
    expect(mpvState.instances).toBe(2);
    expect(mpvState.started).toBe(2);
    expect(svc.getPlayerState()).toBe("available");
    expect(svc.getBackendState()).toBe("ready");
  });

  it("启动失败的实例会被 dispose，不留下野进程", async () => {
    mpvState.failNext = true;
    const svc = service();
    await svc.start();

    expect(mpvState.disposed).toBe(1);
  });

  it("mpv 缺失时 snapshot 带 playerErrorCode，恢复后清空（issue #98 前端提示依据）", async () => {
    mpvState.failNext = true;
    const svc = service();
    await svc.start();
    expect(svc.getSnapshot().player).toBe("unavailable");
    expect(svc.getSnapshot().playerErrorCode).toBe("E_MPV_NOT_FOUND");

    // 环境修好（用户补装 mpv）后重试成功 → 错误码必须清空，否则提示条赖着不走
    mpvState.failNext = false;
    await svc.applyOpenapiConfig({ appId: "app", privateKey: "K".repeat(1600) });
    expect(svc.getSnapshot().player).toBe("available");
    expect(svc.getSnapshot().playerErrorCode).toBeUndefined();
  });

  it("已经跑起来时重复调用不会再 new 实例（幂等，避免丢监听器）", async () => {
    const svc = service();
    await svc.start();
    expect(mpvState.instances).toBe(1);

    // 无凭据时 backendState 停在 "incompatible"，start() 的早退守卫拦不住，
    // 于是每次音乐操作都会重跑 initOpenapi —— 这里模拟那种重复调用。
    await svc.start();
    await svc.start();

    expect(mpvState.instances).toBe(1);
    expect(mpvState.started).toBe(1);
  });
});
