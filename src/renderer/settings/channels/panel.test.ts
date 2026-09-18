// @vitest-environment jsdom
/**
 * QQ 渠道设置面板：鉴权预检必须向主进程索取。
 *
 * 背景回归：渲染端曾内嵌一份「回环判断」副本，只按模式名判断，把 auto 当成回环。
 * 于是在「auto + 机器装了 WSL 虚拟网卡」时不会提示需要 Access Token，
 * 用户保存后被主进程硬拒（主进程把 auto 解析成了非回环地址）。
 *
 * 修法是删掉副本、改为主进程下发权威判定。本文件同时守住这两件事：
 *   1. 结构断言：src/renderer 下不得再出现任何回环判定副本
 *   2. 行为断言：保存路径确实消费主进程判定 —— 需要 token 且未配置时自动生成且不落盘
 *
 * 主进程那份判定的完整用例表在
 * src/main/channels/adapters/qq/onebot-listen-auth.test.ts。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";

const repoRoot = process.cwd();
const SETTINGS_HTML = path.join(repoRoot, "src/renderer/settings/index.html");

// ── 结构断言：渲染端不得保留回环判定副本 ──────────────────────────────

function listRendererSources(): Array<{ file: string; source: string }> {
  const root = path.join(repoRoot, "src/renderer");
  const collected: Array<{ file: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) continue;
      collected.push({
        file: path.relative(repoRoot, absolute).split(path.sep).join("/"),
        source: fs.readFileSync(absolute, "utf8"),
      });
    }
  };
  walk(root);
  return collected;
}

describe("渲染端不得再保留回环判定副本", () => {
  it("src/renderer 下不出现回环判定的特征字面量或同名函数", () => {
    // 「监听地址是否回环」的输入是网络接口列表，只有主进程看得到。
    // 任何渲染端副本都会与主进程漂移，因此这里用源码扫描把它挡住。
    const offenders = listRendererSources()
      .filter(({ source }) => source.includes("::ffff:127.0.0.1") || /\bisLoopbackHost\w*\b/.test(source))
      .map(({ file }) => file);

    expect(offenders, "以下文件重新引入了回环判定；应改为调用主进程的权威预检").toEqual([]);
  });
});

// ── 行为断言：保存路径消费主进程判定 ──────────────────────────────────

const SETTINGS_HTML_IDS = [...fs.readFileSync(SETTINGS_HTML, "utf8").matchAll(/id="([^"]+)"/g)].map(
  (match) => match[1],
);

const ID = {
  enabled: "channels-qq-enabled",
  listenMode: "channels-qq-listen-mode",
  customHost: "channels-qq-custom-host",
  token: "channels-qq-token",
  save: "channels-qq-save",
  feedback: "channels-qq-feedback",
} as const;

/**
 * 用真实 settings/index.html 的 id 清单搭一个最小 DOM：面板模块在 import 时
 * 就静态取元素，因此必须先建 DOM 再 import。只有参与断言的控件换成有表单语义的元素。
 */
function buildDom(): void {
  document.body.innerHTML = SETTINGS_HTML_IDS.map((id) => `<div id="${id}"></div>`).join("");

  const replace = (id: string, element: HTMLElement): void => {
    document.getElementById(id)?.replaceWith(element);
    element.id = id;
  };

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  replace(ID.enabled, enabled);

  replace(ID.customHost, document.createElement("input"));
  replace(ID.token, document.createElement("input"));

  const listenMode = document.createElement("select");
  for (const value of ["auto", "wsl", "loopback", "custom"]) {
    const option = document.createElement("option");
    option.value = value;
    listenMode.append(option);
  }
  replace(ID.listenMode, listenMode);
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`测试 DOM 缺少元素 ${id}`);
  return found as T;
}

interface Harness {
  requirement: QqListenAuthRequirement;
  resolveAuth: ReturnType<typeof vi.fn>;
  saveConfig: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
}

function stubSettings(requirement: QqListenAuthRequirement): Harness {
  const resolveAuth = vi.fn().mockResolvedValue(requirement);
  const saveConfig = vi.fn().mockResolvedValue({});
  const restart = vi.fn().mockResolvedValue({ ok: true });
  const noopSubscription = (): (() => void) => () => {};

  (window as unknown as { settings: unknown }).settings = {
    channelsGetConfig: vi.fn().mockResolvedValue({
      wechat: { enabled: false },
      feishu: { enabled: false },
      qq: { enabled: true, listenMode: "auto", port: 6200 },
      qqbot: { enabled: false },
    }),
    channelsGetStatus: vi.fn().mockResolvedValue({}),
    channelsLogGet: vi.fn().mockResolvedValue([]),
    channelsContextBindingsGet: vi.fn().mockResolvedValue([]),
    channelsSaveConfig: saveConfig,
    channelsRestart: restart,
    channelsQqResolveAuthRequirement: resolveAuth,
    onChannelsInstallProgress: noopSubscription,
    onChannelsStatusChanged: noopSubscription,
    onChannelsWechatQrcode: noopSubscription,
    onChannelsWechatLoginDone: noopSubscription,
  };

  return { requirement, resolveAuth, saveConfig, restart };
}

/** 建 DOM → 载入面板 → 点保存。面板在 import 时静态取元素，故顺序不可换。 */
async function loadPanelAndSave(): Promise<void> {
  vi.resetModules();
  const panel = await import("./panel");
  await panel.loadChannelsPanel();
  element(ID.save).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  buildDom();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("QQ 保存时消费主进程的鉴权判定", () => {
  it("需要 token 且未配置：自动生成、提示实际监听地址、且不落盘", async () => {
    const h = stubSettings({
      ok: true,
      requiresAccessToken: true,
      resolvedHost: "172.20.0.1",
      resolvedMode: "wsl",
    });

    await loadPanelAndSave();
    await vi.waitFor(() => expect(h.resolveAuth).toHaveBeenCalledTimes(1));

    // 预检必须带上当前表单值（用户可能改了模式但还没保存）
    expect(h.resolveAuth).toHaveBeenCalledWith({ listenMode: "auto", customHost: "" });

    await vi.waitFor(() => {
      expect((element<HTMLInputElement>(ID.token)).value).toMatch(/^[0-9a-f]{64}$/);
    });
    await flushAsync();

    // token 未回显给用户前不能落盘，否则用户再也拿不到它
    expect(h.saveConfig).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
    // 提示里要给出真实监听地址，用户才知道为什么要配 token
    expect(element(ID.feedback).textContent).toContain("172.20.0.1");
  });

  it("不需要 token：直接保存并启动", async () => {
    const h = stubSettings({
      ok: true,
      requiresAccessToken: false,
      resolvedHost: "127.0.0.1",
      resolvedMode: "loopback",
    });

    await loadPanelAndSave();
    await vi.waitFor(() => expect(h.saveConfig).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.restart).toHaveBeenCalledTimes(1));

    expect(h.saveConfig.mock.calls[0][0]).toMatchObject({
      qq: { listenMode: "auto", port: 6200 },
    });
    // 没有生成 token 就不该写 accessToken
    expect((h.saveConfig.mock.calls[0][0] as { qq: Record<string, unknown> }).qq.accessToken).toBeUndefined();
  });

  it("监听地址解析失败：给出原因并阻止本次保存", async () => {
    const h = stubSettings({
      ok: false,
      requiresAccessToken: false,
      error: "未检测到 Windows WSL 虚拟网卡 IPv4 地址",
    });

    await loadPanelAndSave();
    await vi.waitFor(() => expect(h.resolveAuth).toHaveBeenCalledTimes(1));
    await flushAsync();

    expect(h.saveConfig).not.toHaveBeenCalled();
    expect(element(ID.feedback).textContent).toContain("WSL");
  });
});
