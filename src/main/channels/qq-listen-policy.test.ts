import { networkInterfaces } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOneBotListenHost, resolveQqListenAuthRequirement } from "./qq-listen-policy";

// 宿主预检必须能独立运行，不能加载后端、传输层或 Electron 设置存储。
vi.mock("./adapters/qq/onebot-reverse-ws", () => { throw new Error("不得加载 QQ 后端"); });
vi.mock("ws", () => { throw new Error("不得加载 WebSocket 传输层"); });
vi.mock("electron", () => { throw new Error("不得加载 Electron"); });
vi.mock("./settings-store", () => { throw new Error("不得加载设置存储"); });
vi.mock("node:os", () => ({
  networkInterfaces: vi.fn(() => {
    throw new Error("ERR_SYSTEM_ERROR: uv_interface_addresses 不可用");
  }),
}));

beforeEach(() => { vi.mocked(networkInterfaces).mockClear(); });

describe("QQ 宿主监听策略", () => {
  it("loopback/custom 预检在网卡枚举不可用时仍可运行（#218）", () => {
    expect(resolveQqListenAuthRequirement({ listenMode: "loopback" })).toEqual({
      ok: true,
      requiresAccessToken: false,
      resolvedHost: "127.0.0.1",
      resolvedMode: "loopback",
    });
    expect(resolveQqListenAuthRequirement({ listenMode: "custom", customHost: " 0.0.0.0 " })).toEqual({
      ok: true,
      requiresAccessToken: true,
      resolvedHost: "0.0.0.0",
      resolvedMode: "custom",
    });
    expect(resolveQqListenAuthRequirement({ listenMode: "custom", customHost: " " })).toEqual({
      ok: false,
      requiresAccessToken: false,
      error: "QQ 自定义监听地址为空",
    });
    expect(networkInterfaces).not.toHaveBeenCalled();
  });

  it.each(["auto", "wsl"] as const)("%s 枚举失败不静默回退为回环", (listenMode) => {
    expect(() => resolveOneBotListenHost(listenMode)).toThrow("ERR_SYSTEM_ERROR");
    expect(resolveQqListenAuthRequirement({ listenMode })).toEqual({
      ok: false,
      requiresAccessToken: false,
      error: "ERR_SYSTEM_ERROR: uv_interface_addresses 不可用",
    });
    expect(networkInterfaces).toHaveBeenCalledTimes(2);
  });

  it("注入网卡时不访问真实网卡，缺省模式仍为 auto", () => {
    expect(resolveQqListenAuthRequirement({}, {})).toEqual({
      ok: true,
      requiresAccessToken: false,
      resolvedHost: "127.0.0.1",
      resolvedMode: "loopback",
    });
    expect(networkInterfaces).not.toHaveBeenCalled();
  });
});
