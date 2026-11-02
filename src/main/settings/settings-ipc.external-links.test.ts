import { beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
const shell = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("electron", () => ({ shell }));
vi.mock("../style-prompt", () => ({}));
vi.mock("../windows/window-state", () => ({ reactChatWindow: null }));
vi.mock("../rag/reranker", () => ({}));
vi.mock("../rag", () => ({}));
vi.mock("../orchestrator/vendors/test-connection", () => ({}));
vi.mock("../orchestrator/vendors", () => ({}));
vi.mock("./model-settings", () => ({}));
vi.mock("../timeout-manager", () => ({}));
vi.mock("../chats/chats-ipc", () => ({}));
vi.mock("./data-dir-ipc", () => ({ registerDataDirIpc: vi.fn() }));
vi.mock("../browser/browser-panel-runtime", () => ({}));
vi.mock("../system-ui-theme", () => ({ watchSystemUiTheme: vi.fn() }));
import { registerSettingsIpc, type SettingsIpcDependencies } from "./settings-ipc";
let open: (event: unknown, url: string) => Promise<unknown>;
beforeEach(() => {
  shell.openExternal.mockReset().mockResolvedValue(undefined);
  // 只登记生产 IPC 回调；所有外部模块隔离，不启动应用或访问真实配置。
  registerSettingsIpc({ ipc: { handle(channel, callback) { if (channel === IPC.OPEN_EXTERNAL) open = callback as typeof open; }, on() {}, removeHandler() {}, dispose() {} } } as SettingsIpcDependencies);
});
it.each(["mailto:ky2569ly@gmail.com", "https://github.com/Playa-Cyrene/Cyrene-Agent", "http://example.com"])("既有 IPC 允许协议 %s 并交给模拟 shell", async (url) => {
  expect(await open(null, url)).toEqual({ ok: true });
  expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
});
it.each(["javascript:alert(1)", "file:///tmp/private", "data:text/html,test", "ftp://example.com", "custom:run"])("既有 IPC 拒绝协议 %s，不调用 shell", async (url) => {
  expect(await open(null, url)).toEqual({ ok: false, error: "Invalid URL" });
  expect(shell.openExternal).not.toHaveBeenCalled();
});
it("系统邮件应用失败以结果返回，不吞掉失败或再次打开", async () => {
  shell.openExternal.mockRejectedValue(new Error("No mail client"));
  expect(await open(null, "mailto:ky2569ly@gmail.com")).toEqual({ ok: false, error: "Error: No mail client" });
  expect(shell.openExternal).toHaveBeenCalledTimes(1);
});
