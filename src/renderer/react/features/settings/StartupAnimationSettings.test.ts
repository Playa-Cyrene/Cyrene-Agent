// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StartupAnimationSettings } from "./StartupAnimationSettings";
import { setUiLocale } from "../../i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; });

it("uses shared controls, imports/cancels/resets immediately, and preserves toggle on failure", async () => {
  setUiLocale("zh-CN");
  let state = { enabled: true, videoFile: null as string | null, videoName: null as string | null };
  const api = {
    get: vi.fn(async () => state),
    setEnabled: vi.fn(async (enabled: boolean) => (state = { ...state, enabled })),
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
  const toggle = host.querySelector<HTMLButtonElement>(".cy-control-switch[role=switch]")!;
  const button = (name: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent === name)!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(api.setEnabled).toHaveBeenCalledWith(false);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
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
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  api.setEnabled.mockRejectedValueOnce(new Error("Cannot save"));
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).toContain("Cannot save");
  expect(host.querySelector('[role="alert"]')?.closest(".cy-settings-row")).toBe(languageRow.previousElementSibling);
  expectDivider();
});
