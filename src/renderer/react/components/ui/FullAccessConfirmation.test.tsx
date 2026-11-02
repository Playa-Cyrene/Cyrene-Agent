// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import i18next from "i18next";
import { FullAccessConfirmation } from "./FullAccessConfirmation";
import { PermissionControl } from "../../features/chat/components/PermissionControl";

let root: Root;
let host: HTMLDivElement;
let confirm: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  await i18next.changeLanguage("zh-CN");
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  confirm = vi.fn().mockResolvedValue(true); cancel = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete (window as any).settings;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function render(open = true) {
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><FullAccessConfirmation open={open} onCancel={cancel} onConfirm={confirm} /></ConfigProvider>));
}
async function click(el: Element) { await act(async () => (el as HTMLElement).click()); }
const ok = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!;
const cancelButton = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-default")!;
async function waitSeconds(n = 5) { for (let i = 0; i < n; i++) await act(async () => vi.advanceTimersByTime(1000)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it("等待五秒前不能授权，取消不调用保存，重开重新等待", async () => {
  await render(); expect(ok().disabled).toBe(true);
  await click(ok()); expect(confirm).not.toHaveBeenCalled();
  await waitSeconds(4); expect(ok().disabled).toBe(true);
  await click(cancelButton()); expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
  await render(false); await render(); expect(ok().textContent).toContain("5");
  await waitSeconds(); expect(ok().disabled).toBe(false);
  await click(ok()); expect(confirm).toHaveBeenCalledOnce();
});

it.each(["close", "escape"])("%s 关闭不发授权", async kind => {
  await render(); await waitSeconds();
  if (kind === "close") await click(document.querySelector(".ant-modal-close")!);
  else await act(async () => document.querySelector(".ant-modal-wrap")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })));
  expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
});

it("同一事件循环重复确认只保存一次，在途不能假取消", async () => {
  const pending = deferred<boolean>(); confirm.mockReturnValue(pending.promise);
  await render(); await waitSeconds();
  await act(async () => { ok().click(); ok().click(); });
  expect(confirm).toHaveBeenCalledOnce(); expect(cancelButton().disabled).toBe(true);
  await click(cancelButton()); expect(cancel).not.toHaveBeenCalled();
  await act(async () => pending.resolve(true)); expect(cancel).toHaveBeenCalledOnce();
});

it.each([false, "reject"])("保存失败 %s 显示错误，不关闭，允许明确重试", async value => {
  if (value === false) confirm.mockResolvedValueOnce(false); else confirm.mockRejectedValueOnce(new Error("disk"));
  await render(); await waitSeconds(); await click(ok());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("失败");
  expect(cancel).not.toHaveBeenCalled();
  await click(ok()); expect(confirm).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
});

it("阅读完整条款不会授权或替代确认", async () => {
  await render();
  await click([...document.querySelectorAll("button")].find(el => el.textContent?.includes("查看 Agent"))!);
  expect(document.body.textContent).toContain("免责声明");
  expect(confirm).not.toHaveBeenCalled();
});

it("关闭或卸载时丢弃倒计时及晚到的完成回调", async () => {
  const pending = deferred<boolean>(); confirm.mockReturnValue(pending.promise);
  await render(); await waitSeconds(); await click(ok()); await render(false);
  await act(async () => pending.resolve(true)); expect(cancel).not.toHaveBeenCalled();
  await render(); expect(ok().disabled).toBe(true); expect(ok().textContent).toContain("5");
});

async function renderQuick() {
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><PermissionControl /></ConfigProvider>));
}
async function chooseFull() {
  await click(document.querySelector(".cy-permission-control")!);
  await click(document.querySelector(".cy-permission-panel__option.is-full")!);
}
it("工作区快捷入口必须确认后才发送 full IPC，取消不保存", async () => {
  const api = { getPermissionLevel: vi.fn().mockResolvedValue({ level: "read-only" }), setPermissionLevel: vi.fn().mockResolvedValue({ ok: true, level: "full" }) };
  (window as any).settings = api;
  await renderQuick(); await chooseFull(); expect(api.setPermissionLevel).not.toHaveBeenCalled();
  await click(cancelButton()); expect(api.setPermissionLevel).not.toHaveBeenCalled();
  await chooseFull(); await waitSeconds(); await click(ok());
  expect(api.setPermissionLevel).toHaveBeenCalledExactlyOnceWith("full");
  expect(document.querySelector(".cy-permission-control")?.className).toContain("is-full");
});

it("快捷入口保存失败不会显示已进入 full，确认失败可取消", async () => {
  const api = { getPermissionLevel: vi.fn().mockResolvedValue({ level: "read-only" }), setPermissionLevel: vi.fn().mockResolvedValue({ ok: false }) };
  (window as any).settings = api;
  await renderQuick(); await chooseFull(); await waitSeconds(); await click(ok());
  expect(document.querySelector(".cy-permission-control")?.className).toContain("is-read-only");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("失败");
  await click(cancelButton()); expect(api.setPermissionLevel).toHaveBeenCalledOnce();
});

it("快捷入口丢弃权限保存之前发出的过期读取", async () => {
  const oldRead = deferred<{ level: string }>();
  const api = { getPermissionLevel: vi.fn().mockResolvedValueOnce({ level: "read-only" }).mockReturnValueOnce(oldRead.promise), setPermissionLevel: vi.fn().mockResolvedValue({ ok: true, level: "full" }) };
  (window as any).settings = api;
  await renderQuick(); await chooseFull(); await waitSeconds(); await click(ok());
  await act(async () => oldRead.resolve({ level: "read-only" }));
  expect(document.querySelector(".cy-permission-control")?.className).toContain("is-full");
});

it("快捷入口降低权限不要求 full 确认", async () => {
  const api = { getPermissionLevel: vi.fn().mockResolvedValue({ level: "full" }), setPermissionLevel: vi.fn().mockResolvedValue({ ok: true, level: "read-only" }) };
  (window as any).settings = api;
  await renderQuick(); await click(document.querySelector(".cy-permission-control")!);
  await click(document.querySelector(".cy-permission-panel__option.is-read-only")!);
  expect(api.setPermissionLevel).toHaveBeenCalledExactlyOnceWith("read-only");
  expect(ok()).toBeNull();
});

it("取消与确认同一事件循环竞争时，取消不能随后隐式授权", async () => {
  await render(); await waitSeconds();
  await act(async () => { cancelButton().click(); ok().click(); });
  expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
});

it("条款层 Escape 仅关闭阅读窗口，原确认保留且未授权", async () => {
  // rc-util 在 test 环境把所有 useId 固定为 test-id，会错误合并弹窗 Esc 栈。
  // 使用真实 React ID，验证实际运行环境的多层弹窗行为。
  vi.stubEnv("NODE_ENV", "development");
  await render();
  await click([...document.querySelectorAll("button")].find(el => el.textContent?.includes("查看 Agent"))!);
  const dialogs = document.querySelectorAll(".ant-modal-wrap");
  expect(dialogs).toHaveLength(2);
  await act(async () => dialogs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })));
  await act(async () => vi.advanceTimersByTime(300));
  expect(document.querySelectorAll(".ant-modal-wrap")).toHaveLength(1);
  expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  await waitSeconds(); await click(ok());
  expect(confirm).toHaveBeenCalledOnce();
});
