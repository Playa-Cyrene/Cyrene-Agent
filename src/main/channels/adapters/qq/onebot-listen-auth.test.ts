/**
 * QQ 监听鉴权判定的权威用例表。
 *
 * 项目里只保留这一份「按监听参数判定是否需要 Access Token」的实现 —— 渲染端不再有
 * 副本（由 settings/channels/panel.test.ts 的结构断言守住）。用例表必须覆盖
 * 「auto 在存在 WSL 虚拟网卡时被解析为非回环地址」这一分支：它正是
 * 「设置页不提示、用户被主进程硬拒」那个回归的触发条件。
 *
 * interfaces 显式注入，避免用例依赖跑测机器的真实网卡。
 */

import { describe, expect, it } from "vitest";
import { resolveQqListenAuthRequirement } from "./onebot-reverse-ws";

type InterfaceMap = Parameters<typeof resolveQqListenAuthRequirement>[1];

/** 装了 WSL 的开发机：存在非回环的 WSL 虚拟网卡 */
const WSL_INTERFACES: InterfaceMap = {
  "vEthernet (WSL)": [
    {
      address: "172.20.0.1",
      netmask: "255.255.240.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "172.20.0.1/20",
    },
  ],
};

/** 只有物理网卡、没有 WSL 的机器 */
const NO_WSL_INTERFACES: InterfaceMap = {
  Ethernet: [
    {
      address: "192.168.1.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:11:22:33:44:55",
      internal: false,
      cidr: "192.168.1.20/24",
    },
  ],
};

/** 与同目录 onebot-reverse-ws.test.ts 的 "classifies loopback hosts" 同宽 */
const LOOPBACK_SPELLINGS = [
  "127.0.0.1",
  "localhost",
  "LOCALHOST",
  "  127.0.0.1  ",
  "::1",
  "[::1]",
  "::ffff:127.0.0.1",
];

const NON_LOOPBACK_SPELLINGS = ["0.0.0.0", "::", "192.168.1.20", "172.20.0.1"];

describe("resolveQqListenAuthRequirement", () => {
  it("auto 按机器是否装了 WSL 分叉：有 WSL 网卡即要求 token", () => {
    // 回归锚点：渲染端曾按模式名把 auto 当成回环，导致这一分支漏报。
    expect(resolveQqListenAuthRequirement({ listenMode: "auto" }, WSL_INTERFACES)).toEqual({
      ok: true,
      requiresAccessToken: true,
      resolvedHost: "172.20.0.1",
      resolvedMode: "wsl",
    });

    expect(resolveQqListenAuthRequirement({ listenMode: "auto" }, NO_WSL_INTERFACES)).toEqual({
      ok: true,
      requiresAccessToken: false,
      resolvedHost: "127.0.0.1",
      resolvedMode: "loopback",
    });
  });

  it("loopback 模式无论网卡如何都不需要 token", () => {
    expect(resolveQqListenAuthRequirement({ listenMode: "loopback" }, WSL_INTERFACES).requiresAccessToken).toBe(false);
    expect(resolveQqListenAuthRequirement({ listenMode: "loopback" }, NO_WSL_INTERFACES).requiresAccessToken).toBe(false);
  });

  it("wsl 模式有网卡时要求 token，无网卡时报解析失败而非要求 token", () => {
    expect(resolveQqListenAuthRequirement({ listenMode: "wsl" }, WSL_INTERFACES)).toEqual({
      ok: true,
      requiresAccessToken: true,
      resolvedHost: "172.20.0.1",
      resolvedMode: "wsl",
    });

    const missing = resolveQqListenAuthRequirement({ listenMode: "wsl" }, NO_WSL_INTERFACES);
    expect(missing.ok).toBe(false);
    expect(missing.requiresAccessToken).toBe(false);
    expect(missing.error).toContain("WSL");
  });

  it("custom 模式按地址是否回环判定", () => {
    for (const customHost of LOOPBACK_SPELLINGS) {
      const result = resolveQqListenAuthRequirement({ listenMode: "custom", customHost }, NO_WSL_INTERFACES);
      expect(result.ok, customHost).toBe(true);
      expect(result.requiresAccessToken, customHost).toBe(false);
      expect(result.resolvedHost, customHost).toBe(customHost.trim());
    }

    for (const customHost of NON_LOOPBACK_SPELLINGS) {
      expect(
        resolveQqListenAuthRequirement({ listenMode: "custom", customHost }, NO_WSL_INTERFACES).requiresAccessToken,
        customHost,
      ).toBe(true);
    }
  });

  it("custom 模式缺地址时报解析失败，而不是悄悄要求 token", () => {
    const result = resolveQqListenAuthRequirement({ listenMode: "custom", customHost: "   " }, NO_WSL_INTERFACES);
    expect(result.ok).toBe(false);
    expect(result.requiresAccessToken).toBe(false);
  });

  it("非法 listenMode 收敛为 auto（与渲染端共用同一份收敛规则）", () => {
    expect(resolveQqListenAuthRequirement({ listenMode: "garbage" }, NO_WSL_INTERFACES)).toEqual(
      resolveQqListenAuthRequirement({ listenMode: "auto" }, NO_WSL_INTERFACES),
    );
    expect(resolveQqListenAuthRequirement({ listenMode: undefined }, WSL_INTERFACES)).toEqual(
      resolveQqListenAuthRequirement({ listenMode: "auto" }, WSL_INTERFACES),
    );
  });
});
