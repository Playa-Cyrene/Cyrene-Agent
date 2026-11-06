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
let handlers: Map<string, (...args: any[]) => any>;
let saved: ReturnType<typeof vi.fn>;
const before = { disclaimerAcceptedVersion: "old", language: "zh-CN" };
beforeEach(() => {
  handlers = new Map();
  saved = vi.fn(value => ({ ...before, ...value }));
  registerSettingsIpc({
    getGeneralSettings: () => before,
    saveGeneralSettings: saved,
    ipc: { handle(channel, callback) { handlers.set(channel, callback); }, on() {}, removeHandler() {}, dispose() {} },
  } as unknown as SettingsIpcDependencies);
});
it("普通设置保存保留其他字段，但不能伪造条款同意", () => {
  const result = handlers.get(IPC.SETTINGS_SAVE_GENERAL)!(null, { disclaimerAcceptedVersion: "2026-11-02", language: "en" });
  expect(saved).toHaveBeenCalledExactlyOnceWith({ language: "en" });
  expect(result).toEqual({ disclaimerAcceptedVersion: "old", language: "en" });
});
it("历史 TTS 保存入口不能修改同意版本", async () => {
  const result = await handlers.get(IPC.TTS_SAVE_SETTINGS)!(null, { disclaimerAcceptedVersion: "2026-11-02", language: "en" });
  expect(saved).toHaveBeenCalledExactlyOnceWith({ disclaimerAcceptedVersion: "old", language: "en" });
  expect(result.disclaimerAcceptedVersion).toBe("old");
});
