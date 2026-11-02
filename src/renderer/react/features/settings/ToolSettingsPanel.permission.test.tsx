// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import i18next from "i18next";
import { ToolSettingsPanel } from "./ToolSettingsPanel";

vi.mock("./MusicSettingsModal", () => ({ MusicSettingsModal: () => null }));
vi.mock("../../../settings/plugin-panels", () => ({ mountPluginPanels: async () => () => {} }));
let root: Root;
let host: HTMLDivElement;
let api: { getGeneral: ReturnType<typeof vi.fn>; getPermissionLevel: ReturnType<typeof vi.fn>; setPermissionLevel: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  await i18next.changeLanguage("zh-CN"); vi.useFakeTimers();
  api = { getGeneral: vi.fn().mockResolvedValue({}), getPermissionLevel: vi.fn().mockResolvedValue({ level: "read-only" }), setPermissionLevel: vi.fn().mockResolvedValue({ ok: true, level: "full" }) };
  (window as any).settings = api;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; delete (window as any).settings; vi.useRealTimers(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><ToolSettingsPanel /></ConfigProvider>)); }
async function click(el: Element) { await act(async () => (el as HTMLElement).click()); }
const full = () => [...document.querySelectorAll<HTMLButtonElement>(".cy-settings-tools__levels button")].find(el => el.textContent?.replace(/\s/g, "") === "完全")!;
const ok = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!;
async function waitFive() { for (let i = 0; i < 5; i++) await act(async () => vi.advanceTimersByTime(1000)); }
it("设置入口复用同一确认，取消不更新，确认成功后使用主进程档位", async () => {
  await render(); await click(full()); expect(ok().disabled).toBe(true); expect(api.setPermissionLevel).not.toHaveBeenCalled();
  await click(document.querySelector(".ant-modal-footer .ant-btn-default")!); expect(api.setPermissionLevel).not.toHaveBeenCalled();
  await click(full()); await waitFive(); await click(ok());
  expect(api.setPermissionLevel).toHaveBeenCalledExactlyOnceWith("full"); expect(full().getAttribute("aria-pressed")).toBe("true");
});
it("设置保存失败不标记 full，保留错误和重试入口", async () => {
  api.setPermissionLevel.mockResolvedValueOnce({ ok: false, error: "save failed" });
  await render(); await click(full()); await waitFive(); await click(ok());
  expect(full().getAttribute("aria-pressed")).toBe("false"); expect(document.querySelector('[role="alert"]')?.textContent).toContain("失败");
  await click(ok()); expect(api.setPermissionLevel).toHaveBeenCalledTimes(2); expect(full().getAttribute("aria-pressed")).toBe("true");
});
