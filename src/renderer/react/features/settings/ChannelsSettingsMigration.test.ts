// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";

vi.mock("./ModelSettingsPanel", () => ({ ModelSettingsPanel: () => null }));
vi.mock("./McpSettingsPanel", () => ({ McpSettingsPanel: () => null }));
vi.mock("@lobehub/icons", () => ({ MCP: () => null }));

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const roots: Root[] = [];

async function renderSettings() {
  function Harness() {
    const [section, setSection] = useState("appearance");
    return createElement(AppearanceSettingsPage, {
      section: section as never,
      onSelectSection: setSection as never,
      onBackToWorkspace: () => {},
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(Harness)); });
  return host;
}

function buttonByText(host: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("external channel settings migration", () => {
  it("places phone connection in its own external channels sidebar group", async () => {
    Object.assign(window, { settings: { getGeneral: async () => ({}) } });
    const host = await renderSettings();

    expect(host.textContent).toContain("外部渠道");
    expect(buttonByText(host, "连接手机")).toBeDefined();
  });

  it("shows global context bindings before the reused channel message log, with logs collapsed by default", async () => {
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({}),
        channelsGetConfig: async () => ({
          wechat: { enabled: true }, feishu: {}, qq: {}, qqbot: {},
          rateLimitPerUser: 10, rateLimitPerChannel: 100,
          ttsEnabled: true, stickerEnabled: true, mirrorToDesktop: true, toolSandbox: "all",
        }),
        channelsGetStatus: async () => ({ wechat: { phase: "running" } }),
        channelsLogGet: async () => [{ at: new Date().toISOString(), dir: "incoming", channel: "wechat", senderId: "u1", chatId: "c1", text: "你好" }],
        channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
        onChannelsStatusChanged: () => () => {},
        onChannelsWechatQrcode: () => () => {},
        onChannelsWechatLoginDone: () => () => {},
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "连接手机")!.click(); });

    const headings = Array.from(host.querySelectorAll("h1, h2")).map((heading) => heading.textContent?.trim());
    expect(headings.indexOf("上下文绑定")).toBeLessThan(headings.indexOf("最近收发记录"));
    const logsToggle = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "展开");
    expect(logsToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("你好");
    await act(async () => { logsToggle!.click(); });
    expect(host.textContent).toContain("你好");
    expect(host.textContent).toContain("微信");

    const toolPermissionRow = Array.from(host.querySelectorAll(".cy-settings-row")).find((row) => row.textContent?.includes("手机端工具权限"));
    expect(toolPermissionRow?.querySelector(".cy-channels-global-select .cy-control-select")).not.toBeNull();
  });

  it("uses labeled provider icons instead of one generic phone icon", async () => {
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({}),
        channelsGetConfig: async () => ({}),
        channelsGetStatus: async () => ({}),
        channelsLogGet: async () => [],
        channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
        onChannelsStatusChanged: () => () => {},
        onChannelsWechatQrcode: () => () => {},
        onChannelsWechatLoginDone: () => () => {},
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "连接手机")!.click(); });

    const iconLabels = Array.from(host.querySelectorAll(".cy-channels-provider__icon [role='img']"))
      .map((icon) => icon.getAttribute("aria-label"));
    expect(iconLabels).toEqual(["微信", "飞书", "QQ（NapCat）", "QQ 机器人"]);
  });

  it("does not send the saved Feishu secret back when saving the channel without replacing it", async () => {
    const saveConfig = vi.fn().mockResolvedValue({});
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({}),
        channelsGetConfig: async () => ({ feishu: { enabled: false, appId: "cli_demo", appSecret: "must-not-be-echoed" } }),
        channelsGetStatus: async () => ({}),
        channelsLogGet: async () => [],
        channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
        channelsSaveConfig: saveConfig,
        channelsRestart: async () => ({}),
        onChannelsStatusChanged: () => () => {},
        onChannelsWechatQrcode: () => () => {},
        onChannelsWechatLoginDone: () => () => {},
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "连接手机")!.click(); });
    const feishuCard = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("飞书"));
    await act(async () => { feishuCard!.click(); });
    const saveButton = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "保存并连接");
    await act(async () => { saveButton!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(saveConfig).toHaveBeenCalledWith({ feishu: { enabled: false, appId: "cli_demo" } });
    expect(document.body.textContent).not.toContain("must-not-be-echoed");
  });
});
