// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StartupAnimationSettings } from "./StartupAnimationSettings";
import { setUiLocale } from "../../i18n";
import type { StartupAnimationMode } from "../../../../shared/startup-animation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; });

it("uses four shared segmented options, preserves mode on reset/failure and keeps row dividers", async () => {
  setUiLocale("zh-CN");
  let state = { enabled: true, mode: "startup" as StartupAnimationMode, videoFile: null as string | null, videoName: null as string | null };
  const api = {
    get: vi.fn(async () => state),
    setMode: vi.fn(async (mode: StartupAnimationMode) => (state = { ...state, mode, enabled: mode !== "off" })),
    importVideo: vi.fn(async () => null as typeof state | null),
    resetVideo: vi.fn(async () => (state = { ...state, videoFile: null, videoName: null })),
  };
  Object.assign(window, { settings: { startupAnimation: api } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Fragment, null,
    createElement(StartupAnimationSettings),
    createElement("div", { className: "cy-settings-row", "data-testid": "language-row" }, "界面语言"),
  )));
  const languageRow = host.querySelector('[data-testid="language-row"]')!;
  function expectDivider() {
    // The shared stylesheet draws borders only between adjacent settings rows.
    expect(languageRow.matches(".cy-settings-row + .cy-settings-row")).toBe(true);
    expect(languageRow.previousElementSibling?.textContent).toContain("动画视频");
    expect(host.children.length).toBe(3);
  }
  expectDivider();
  const option = (name: string) => Array.from(host.querySelectorAll<HTMLLabelElement>(".cy-control-segmented label")).find((item) => item.textContent === name)!;
  const checked = (name: string) => option(name).querySelector<HTMLInputElement>("input")!.checked;
  const button = (name: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent === name)!;
  expect(checked("仅启动时播放")).toBe(true);
  for (const [label, mode] of [["每次播放", "always"], ["除托盘外其余播放", "except-tray"], ["关闭", "off"]]) {
    await act(async () => option(label).click());
    expect(api.setMode).toHaveBeenLastCalledWith(mode);
    expect(checked(label)).toBe(true);
  }
  expect(host.querySelector('[role="status"]')?.closest(".cy-settings-row")).toBe(languageRow.previousElementSibling);
  expectDivider();
  await act(async () => button("导入视频").click());
  expect(host.textContent).toContain("默认 · 昔涟启动动画");
  expectDivider();
  api.importVideo.mockImplementationOnce(async () => (state = { ...state, videoFile: "custom.mp4", videoName: "My video.mp4" }));
  await act(async () => button("导入视频").click());
  expect(host.textContent).toContain("My video.mp4");
  expectDivider();
  await act(async () => button("恢复默认").click());
  expect(api.resetVideo).toHaveBeenCalledTimes(1);
  expectDivider();
  expect(checked("关闭")).toBe(true);
  api.setMode.mockRejectedValueOnce(new Error("Cannot save"));
  await act(async () => option("每次播放").click());
  expect(checked("关闭")).toBe(true);
  expect(host.textContent).toContain("Cannot save");
  expect(host.querySelector('[role="alert"]')?.closest(".cy-settings-row")).toBe(languageRow.previousElementSibling);
  expectDivider();
});
