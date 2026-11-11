// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import i18next from "i18next";
import type { QqModuleInstallationStatus } from "../../../../shared/qq-module-installation";
import { QqModuleInstallationCard } from "./QqModuleInstallationCard";

const status: QqModuleInstallationStatus = { availability: "release-unconfigured", canInstall: false, moduleInstalled: false, currentDriver: "legacy-builtin", listenCompatibility: "loopback" };
let root: Root, host: HTMLDivElement;
const api = { channelsQqModuleInstallationStatus: vi.fn<() => Promise<QqModuleInstallationStatus>>() };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  await i18next.changeLanguage("zh-CN");
  api.channelsQqModuleInstallationStatus.mockReset().mockResolvedValue(status);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><QqModuleInstallationCard api={api} listenMode="loopback" customHost="" /></ConfigProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((e) => e.textContent?.replaceAll(" ", "").includes(text))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };

it("waits for an explicit click before querying status and never enables install", async () => {
  expect(api.channelsQqModuleInstallationStatus).not.toHaveBeenCalled();
  await click(button("查看模块安装条件"));
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("信任根尚未配置");
  expect(button("下载并安装").disabled).toBe(true);
  await click(button("下载并安装"));
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("当前版本仍保留原内建 QQ 接入");
});
it("repeated entry clicks, cancel and reopen do not initiate installation", async () => {
  await act(async () => { button("查看模块安装条件").click(); button("查看模块安装条件").click(); });
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledOnce();
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(button("查看模块安装条件"));
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledTimes(2);
  expect(button("下载并安装").disabled).toBe(true);
});
it("keeps installation disabled on read failure and retries after closing", async () => {
  api.channelsQqModuleInstallationStatus.mockRejectedValueOnce(new Error("private path and token must not be shown"));
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("无法确认安装状态");
  expect(document.body.textContent).not.toContain("private path");
  expect(button("下载并安装").disabled).toBe(true);
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("信任根尚未配置");
});
it("ignores a stale response after cancel/reopen and fails closed on unexpected status", async () => {
  let resolve!: (value: QqModuleInstallationStatus) => void;
  api.channelsQqModuleInstallationStatus.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  await click(button("查看模块安装条件"));
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  api.channelsQqModuleInstallationStatus.mockResolvedValueOnce({ ...status, canInstall: true } as never);
  await click(button("查看模块安装条件"));
  await act(async () => resolve(status));
  expect(document.body.textContent).toContain("无法确认安装状态");
  expect(button("下载并安装").disabled).toBe(true);
});
it("explains unsupported WSL/remote settings without rewriting them", async () => {
  api.channelsQqModuleInstallationStatus.mockResolvedValueOnce({ ...status, listenCompatibility: "unsupported-host" });
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("地址不受首版独立模块支持");
  expect(document.body.textContent).toContain("Token 不会开启远程支持");
  expect(button("下载并安装").disabled).toBe(true);
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledExactlyOnceWith({ listenMode: "loopback", customHost: "" });
});
it("does not keep a prior loopback success when a reopened query fails", async () => {
  await click(button("查看模块安装条件"));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("当前监听预检：本机回环");
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  api.channelsQqModuleInstallationStatus.mockRejectedValueOnce(new Error("failed"));
  await click(button("查看模块安装条件"));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("地址无法确定");
  expect(document.body.textContent).not.toContain("当前监听预检：本机回环");
});
