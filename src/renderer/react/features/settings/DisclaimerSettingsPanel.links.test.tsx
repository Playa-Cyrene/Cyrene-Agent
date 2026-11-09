// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DisclaimerSettingsPanel } from "./DisclaimerSettingsPanel";

let root: Root;
let host: HTMLDivElement;
const openExternal = vi.fn();
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("system", { openExternal });
  openExternal.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<DisclaimerSettingsPanel />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function clickEmail(email = "ky2569ly@gmail.com") {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => host.querySelector<HTMLAnchorElement>(`a[href="mailto:${email}"]`)!.dispatchEvent(event));
  return event;
}
it.each(["ky2569ly@gmail.com", "Liang_zh_@outlook.com"])("邮件点击 %s 取消新窗口导航，通过受限系统 IPC 打开对应地址", async (email) => {
  const event = await clickEmail(email);
  expect(event.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(`mailto:${email}`);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it.each(["response", "rejection", "unavailable"])("邮件打开失败 %s 可见提示、保留地址且不回退导航", async (mode) => {
  if (mode === "response") openExternal.mockResolvedValue({ ok: false, error: "no mail client" });
  if (mode === "rejection") openExternal.mockRejectedValue(new Error("IPC unavailable"));
  if (mode === "unavailable") vi.stubGlobal("system", undefined);
  expect((await clickEmail()).defaultPrevented).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(host.querySelector('a[href="mailto:ky2569ly@gmail.com"]')).not.toBeNull();
  vi.stubGlobal("system", { openExternal }); openExternal.mockResolvedValue({ ok: true });
  await clickEmail();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("HTTPS 链接保持现有外部链接策略，不走邮件 IPC", async () => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  // 捕获默认是否被组件阻止，然后在 document 阶段取消，避免 jsdom 真导航。
  let prevented = true;
  const stopNavigation = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  document.addEventListener("click", stopNavigation, { once: true });
  await act(async () => host.querySelector('a[href^="https:"]')!.dispatchEvent(event));
  expect(prevented).toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
});
