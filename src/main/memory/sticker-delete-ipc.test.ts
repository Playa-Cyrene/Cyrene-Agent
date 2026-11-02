import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { StickerConfigItem } from "../../shared/sticker-types";

const state = vi.hoisted(() => ({
  root: "",
  handlers: new Map<string, (...args: any[]) => any>(),
  exposed: new Map<string, any>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => state.handlers.get(channel)!({}, ...args)),
}));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  dialog: {}, webUtils: {},
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => state.exposed.set(name, api) },
  ipcRenderer: { invoke: state.invoke },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler),
    on() {}, removeHandler() {}, removeListener() {},
  },
}));
vi.mock("fs", async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));
// 只装配表情包链路；其余 IPC 依赖不连接网络、不访问真实设置、不启动窗口或后台服务。
vi.mock("../settings-store", () => ({ getStickerSettingsPath: () => path.join(state.root, "sticker-settings.json") }));
vi.mock("./panel", () => ({}));
vi.mock("../orchestrator/mcp-manager", () => ({}));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({}));
vi.mock("../settings/settings-facade", () => ({}));
vi.mock("../skills", () => ({}));
vi.mock("../windows/window-state", () => ({}));
vi.mock("./memory-store", () => ({}));
vi.mock("./obsidian-exporter", () => ({}));
vi.mock("./obsidian-vault-config", () => ({ loadObsidianVaultConfig: () => ({}) }));
vi.mock("./obsidian-importer", () => ({}));
vi.mock("../chats/active-conversation-registry", () => ({}));
vi.mock("../chats/chats-store", () => ({}));
vi.mock("./summary-memory-context", () => ({}));
vi.mock("./memory-mode", () => ({}));

import { registerMemoryUserToolIpc } from "./memory-user-ipc";
import { addUserSticker, loadUserStickerManifest } from "../sticker-storage";
import { clearStickerSettingsCache } from "../orchestrator/sticker-settings";

let api: {
  getConfig(): Promise<StickerConfigItem[]>;
  deleteSticker(id: string): Promise<StickerConfigItem[]>;
  setEnabled(id: string, enabled: boolean): Promise<StickerConfigItem[]>;
};
beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sticker-ipc-"));
  state.handlers.clear(); state.invoke.mockClear(); clearStickerSettingsCache();
  registerMemoryUserToolIpc({ windowManager: null });
  await import("../../preload/index");
  api = state.exposed.get("stickerManager");
  const source = path.join(state.root, "source.png");
  fs.writeFileSync(source, "image");
  await addUserSticker(source, "cat", "猫", []);
});
afterEach(() => {
  vi.restoreAllMocks(); clearStickerSettingsCache();
  fs.rmSync(state.root, { recursive: true, force: true });
});

it("真实 preload → 注册 handler → 存储返回新列表，重新读取不会恢复已删除项", async () => {
  expect((await api.getConfig()).find(item => item.id === "cat")?.builtIn).toBe(false);
  const updated = await api.deleteSticker("cat");
  expect(state.invoke).toHaveBeenLastCalledWith(IPC.STICKERS_DELETE, "cat");
  expect(updated.some(item => item.id === "cat")).toBe(false);
  expect((await api.getConfig()).some(item => item.id === "cat")).toBe(false);
  expect(loadUserStickerManifest().cat).toBeUndefined();
  expect(fs.existsSync(path.join(state.root, "stickers", "cat.png"))).toBe(false);
});

it("文件删除失败沿完整接口拒绝，不返回伪成功列表", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
  await expect(api.deleteSticker("cat")).rejects.toThrow("EPERM");
  expect((await api.getConfig()).some(item => item.id === "cat")).toBe(true);
});

it("绕过渲染端直接删除内置项也会拒绝，仍可禁用并重新读取", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(api.deleteSticker("calm")).rejects.toThrow("不能删除");
  await api.setEnabled("calm", false);
  clearStickerSettingsCache();
  expect((await api.getConfig()).find(item => item.id === "calm")).toMatchObject({ enabled: false, builtIn: true });
});
