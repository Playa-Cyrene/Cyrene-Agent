// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import i18next from "i18next";
import type { QqModuleInstallationStatus } from "../../../../shared/qq-module-installation";
import { QqModuleInstallationCard } from "./QqModuleInstallationCard";

const status: QqModuleInstallationStatus = { availability: "release-unconfigured", canInstall: false, moduleInstalled: false, currentDriver: "legacy-builtin", listenCompatibility: "loopback", tokenCompatibility: "available" };
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

it.each(["required", "unresolved"] as const)("shows saved token %s without enabling install or rewriting credentials", async (tokenCompatibility) => {
  api.channelsQqModuleInstallationStatus.mockResolvedValueOnce({ ...status, tokenCompatibility });
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("即使仅监听本机回环，也必须配置非空白 Access Token");
  expect(document.body.textContent).toContain(tokenCompatibility === "required" ? "Token 缺失或仅含空白" : "无法确认已保存的 Token");
  expect(button("下载并安装").disabled).toBe(true);
  expect(api.channelsQqModuleInstallationStatus).toHaveBeenCalledExactlyOnceWith({ listenMode: "loopback", customHost: "" });
});
it("clears a previous available-token result after a failed reopened query", async () => {
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("已读取到非空白 Token");
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  api.channelsQqModuleInstallationStatus.mockRejectedValueOnce(new Error("private-token"));
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).not.toContain("已读取到非空白 Token");
  expect(document.body.textContent).not.toContain("private-token");
  expect(document.body.textContent).toContain("无法确认已保存的 Token");
});

const packageId = `pkg-${"a".repeat(64)}`;
const configured = async (action: ReturnType<typeof vi.fn>) => {
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><QqModuleInstallationCard api={{ ...api, channelsQqModuleAction: action }} listenMode="loopback" customHost="" /></ConfigProvider>));
  await click(button("查看模块安装条件"));
};
it("requires separate installation preview and confirmation and does not claim activation", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockResolvedValueOnce({ ok: true, state: "preview-install", preview: { operationId: "install-1", packageId, version: "0.1.0" } })
    .mockResolvedValueOnce({ ok: true, state: "installed" });
  await configured(action); await click(button("预览安装候选"));
  expect(action).toHaveBeenLastCalledWith({ action: "preview-install" });
  await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-install", operationId: "install-1", userConfirmed: true });
  expect(document.body.textContent).toContain("候选包已安装，尚未切换账号或启动模块");
  expect(document.body.textContent).not.toContain("当前运行实例已激活");
});
it("cancels preview on closing and requires fresh status on reopening", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, state: "cancelled" })
    .mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockResolvedValueOnce({ ok: true, state: "preview-migration", preview: { operationId: "migration-1", packageId, accountId: "10000" } });
  await configured(action); await click(button("预览迁移原账号"));
  expect(button("明确确认").disabled).toBe(true);
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  expect(action).toHaveBeenLastCalledWith({ action: "cancel", operationId: "migration-1" });
  action.mockResolvedValueOnce({ ok: true, state: "ready" }); await click(button("查看模块安装条件"));
  expect(action).toHaveBeenLastCalledWith({ action: "status" }); expect(document.body.textContent).not.toContain("请输入所显示的账号确认");
});
it("blocks close and duplicate confirmation while installation is pending", async () => {
  let finish!: (r: unknown) => void;
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockResolvedValueOnce({ ok: true, state: "preview-install", preview: { operationId: "install-2", packageId } })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await configured(action); await click(button("预览安装候选"));
  await act(async () => { button("明确确认").click(); button("明确确认")?.click(); });
  expect(action).toHaveBeenCalledTimes(3); expect(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!.disabled).toBe(true);
  await act(async () => finish({ ok: false, error: "operation-failed" }));
  expect(document.body.textContent).toContain("未自动重试"); expect(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!.disabled).toBe(false);
});
it("never exposes raw action exceptions and cancels a late preview after unmount", async () => {
  let finish!: (r: unknown) => void;
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, state: "cancelled" });
  await configured(action); await click(button("预览安装候选"));
  await act(async () => root.render(<div />));
  await act(async () => finish({ ok: true, state: "preview-install", preview: { operationId: "late", packageId } }));
  expect(action).toHaveBeenLastCalledWith({ action: "cancel", operationId: "late" }); expect(document.querySelector('[role="dialog"]')).toBeNull();
});
const enter = async (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
it("requires typed matching account for migration and sends only the preview identity", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockResolvedValueOnce({ ok: true, state: "preview-migration", preview: { operationId: "m3", packageId, accountId: "10000" } })
    .mockResolvedValueOnce({ ok: true, state: "committed" });
  await configured(action); await click(button("预览迁移原账号"));
  await enter("请输入所显示的账号确认：", "999"); expect(button("明确确认").disabled).toBe(true);
  await enter("请输入所显示的账号确认：", "10000"); await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-migration", operationId: "m3", accountId: "10000", userConfirmed: true });
  expect(document.body.textContent).toContain("当前运行实例已激活"); expect(button("预览安装候选")).toBeUndefined();
});
it("first setup accepts only a numeric expected account and requires a separate matching confirmation", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "ready" })
    .mockResolvedValueOnce({ ok: true, state: "preview-setup", preview: { operationId: "s1", packageId, accountId: "12345" } })
    .mockResolvedValueOnce({ ok: true, state: "recovery-required" });
  await configured(action); await enter("首次配置的 QQ 账号", "https://example.com"); expect(button("预览首次配置").disabled).toBe(true);
  await enter("首次配置的 QQ 账号", "12345"); await click(button("预览首次配置"));
  expect(action).toHaveBeenLastCalledWith({ action: "preview-setup", accountId: "12345" }); expect(button("明确确认").disabled).toBe(true);
  await enter("请输入所显示的账号确认：", "12345"); await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-setup", operationId: "s1", accountId: "12345", userConfirmed: true });
  expect(document.body.textContent).toContain("需要恢复检查，未自动重启任何驱动");
});

it("shows already committed activation on reopening without legacy or install claims", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, state: "committed" });
  await configured(action);
  expect(document.body.textContent).toContain("当前运行实例已激活");
  expect(document.body.textContent).not.toContain("当前版本仍保留原内建 QQ 接入");
  expect(document.body.textContent).not.toContain("操作未完成或状态无法确认");
  expect(button("预览安装候选")).toBeUndefined();
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  await click(button("查看模块安装条件"));
  expect(document.body.textContent).toContain("当前运行实例已激活");
  expect(action).toHaveBeenCalledTimes(2);
});
it("requires preview and typed account before recovery reactivation, without automatic replay", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "recovery-required" })
    .mockResolvedValueOnce({ ok: true, state: "preview-recovery", preview: { operationId: "r1", packageId, accountId: "10000" } })
    .mockResolvedValueOnce({ ok: true, state: "committed" });
  await configured(action); expect(action).toHaveBeenCalledTimes(1); expect(button("预览安装候选")).toBeUndefined();
  await click(button("预览恢复并重新激活")); expect(button("明确确认").disabled).toBe(true);
  expect(document.body.textContent).toContain("不会重放旧消息");
  await enter("请输入所显示的账号确认：", "10000"); await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-recovery", operationId: "r1", accountId: "10000", userConfirmed: true });
  expect(document.body.textContent).toContain("当前运行实例已激活");
});
it("shows host-owned disable plan and only sends one-shot reconfiguration consent", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "committed" })
    .mockResolvedValueOnce({ ok: true, state: "preview-reconfigure", preview: { operationId: "c1", packageId, accountId: "10000", desiredEnabled: false, changes: ["enabled", "credential"] } })
    .mockResolvedValueOnce({ ok: true, state: "disabled" });
  await configured(action); await click(button("预览受控配置变更"));
  expect(document.body.textContent).toContain("安全停止所有 QQ 驱动并保持停用");
  expect(document.body.textContent).toContain("主机保存的凭据变更（不显示凭据）");
  await enter("请输入所显示的账号确认：", "10000"); await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-reconfigure", operationId: "c1", accountId: "10000", userConfirmed: true });
  expect(document.body.textContent).toContain("QQ 模块已安全停用"); expect(button("预览恢复并重新激活")).toBeUndefined();
});
it("keeps disabled state explicit on reopening and cancels a reconfigure preview without applying it", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "disabled" })
    .mockResolvedValueOnce({ ok: true, state: "preview-reconfigure", preview: { operationId: "c2", packageId, accountId: "10000", desiredEnabled: true, changes: ["enabled", "allowlist"] } })
    .mockResolvedValueOnce({ ok: true, state: "cancelled" });
  await configured(action); expect(document.body.textContent).not.toContain("当前版本仍保留原内建 QQ 接入");
  await click(button("预览受控配置变更")); expect(document.body.textContent).toContain("白名单变更");
  await click(button("取消预览")); expect(action).toHaveBeenLastCalledWith({ action: "cancel", operationId: "c2" });
  expect(action.mock.calls.some(([c]) => c.action === "confirm-reconfigure")).toBe(false);
});

it("offers controlled reconfiguration from a new-host recovery-required status without assuming disabled proof", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "recovery-required" })
    .mockResolvedValueOnce({ ok: true, state: "preview-reconfigure", preview: { operationId: "new-host", packageId, accountId: "10000", desiredEnabled: true, changes: ["enabled", "credential"] } })
    .mockResolvedValueOnce({ ok: true, state: "committed" });
  await configured(action);
  expect(document.body.textContent).toContain("需要恢复检查");
  expect(document.body.textContent).not.toContain("QQ 模块已安全停用");
  expect(action).toHaveBeenCalledTimes(1);
  await click(button("预览受控配置变更")); expect(button("明确确认").disabled).toBe(true);
  expect(action).toHaveBeenLastCalledWith({ action: "preview-reconfigure" });
  await enter("请输入所显示的账号确认：", "10000"); await click(button("明确确认"));
  expect(action).toHaveBeenLastCalledWith({ action: "confirm-reconfigure", operationId: "new-host", accountId: "10000", userConfirmed: true });
  expect(document.body.textContent).toContain("当前运行实例已激活");
});
it("does not treat rejected recovery as activation and permits reconfiguration after a fresh status check", async () => {
  const action = vi.fn().mockResolvedValueOnce({ ok: true, state: "recovery-required" })
    .mockResolvedValueOnce({ ok: false, error: "recovery-required" })
    .mockResolvedValueOnce({ ok: true, state: "recovery-required" });
  await configured(action); await click(button("预览恢复并重新激活"));
  expect(document.body.textContent).not.toContain("当前运行实例已激活");
  expect(action.mock.calls.some(([c]) => c.action.startsWith("confirm-"))).toBe(false);
  await click(document.querySelector<HTMLButtonElement>(".ant-modal-footer button")!);
  await click(button("查看模块安装条件"));
  expect(button("预览受控配置变更").disabled).toBe(false);
  expect(document.body.textContent).toContain("需要恢复检查");
});
