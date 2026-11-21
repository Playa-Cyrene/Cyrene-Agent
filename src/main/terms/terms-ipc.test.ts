import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { TermsSnapshot } from "../../shared/terms-types";

const electron = vi.hoisted(() => ({
  appPath: "/trusted application",
  fromWebContents: vi.fn(),
  getAllWindows: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getAppPath: () => electron.appPath },
  BrowserWindow: { fromWebContents: electron.fromWebContents, getAllWindows: electron.getAllWindows },
}));
vi.mock("../env", () => ({ isDev: false }));
import { broadcastTermsSnapshot, isTrustedTermsPage, isTrustedTermsSender, registerTermsIpc } from "./terms-ipc";

const page = () => pathToFileURL(path.join(electron.appPath, "dist/renderer/react/index.html")).href;
function eventFor(url = page()) {
  const frame = { url };
  return {
    sender: { isDestroyed: () => false, getURL: () => url, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}
beforeEach(() => {
  vi.clearAllMocks();
  electron.fromWebContents.mockReturnValue({ isDestroyed: () => false });
  electron.getAllWindows.mockReturnValue([]);
});

describe("条款 IPC 来源边界", () => {
  it("允许带查询和路由的真实应用页以及显式开发页面", () => {
    expect(isTrustedTermsPage(`${page()}?onboarding=1#terms`, electron.appPath, false)).toBe(true);
    expect(isTrustedTermsPage("http://localhost:5173/react/?onboarding=1", electron.appPath, true)).toBe(true);
    expect(isTrustedTermsPage("http://localhost:5173/react/", electron.appPath, false)).toBe(false);
    expect(isTrustedTermsSender(eventFor())).toBe(true);
  });
  it.each([
    "https://example.com/react/", "http://localhost:5173.evil.test/react/",
    "http://localhost:5173/other/", "file:///tmp/react/index.html", "javascript:alert(1)", "not a url",
  ])("拒绝非应用页面 %s", url => {
    expect(isTrustedTermsPage(url, electron.appPath, false)).toBe(false);
    expect(isTrustedTermsSender(eventFor(url))).toBe(false);
  });
  it("拒绝 iframe、无归属页面和已销毁窗口", () => {
    const event = eventFor();
    expect(isTrustedTermsSender({ ...event, senderFrame: { url: page() } } as never)).toBe(false);
    electron.fromWebContents.mockReturnValue(null);
    expect(isTrustedTermsSender(event)).toBe(false);
    electron.fromWebContents.mockReturnValue({ isDestroyed: () => true });
    expect(isTrustedTermsSender(event)).toBe(false);
  });
  it("只向可信应用窗口广播，不向网页面板泄露状态", () => {
    const send = vi.fn();
    const remoteSend = vi.fn();
    electron.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: page, send } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => "https://example.com", send: remoteSend } },
    ]);
    const snapshot = { revision: 2 } as TermsSnapshot;
    broadcastTermsSnapshot(snapshot);
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC.TERMS_UPDATED, snapshot);
    expect(remoteSend).not.toHaveBeenCalled();
  });
  it("注册的 GET/ACCEPT 均验证来源并完整转交快照请求", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const snapshot = { revision: 2, consentVersion: "2026-11-03", contentHash: "old", accepted: false } as TermsSnapshot;
    const service = { getSnapshot: vi.fn(() => snapshot), accept: vi.fn(() => ({ ok: false, error: "changed" as const, snapshot })) };
    registerTermsIpc({ ipc: { handle: (key, fn) => { handlers.set(key, fn); }, on() {}, dispose() {}, removeHandler() {} }, service });
    const request = { revision: 2, consentVersion: "2026-11-03", contentHash: "old" };
    const event = eventFor();
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, request)).toEqual({ ok: false, error: "changed", snapshot });
    expect(service.accept).not.toHaveBeenCalled();
    expect(handlers.get(IPC.TERMS_GET)!(event)).toBe(snapshot);
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, { ...request, contentHash: "forged" })).toMatchObject({ ok: false, error: "changed" });
    expect(service.accept).not.toHaveBeenCalled();
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, request)).toEqual({ ok: false, error: "changed", snapshot });
    expect(service.accept).toHaveBeenCalledExactlyOnceWith(request);
    // 另一窗口即使知道内容摘要，也必须通过自己的 GET 取得快照。
    expect(handlers.get(IPC.TERMS_ACCEPT)!(eventFor(), request)).toMatchObject({ ok: false, error: "changed" });
    const next = { ...snapshot, revision: 3, contentHash: "new" };
    service.getSnapshot.mockReturnValue(next);
    expect(handlers.get(IPC.TERMS_GET)!(event)).toBe(next);
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, request)).toMatchObject({ ok: false, error: "changed", snapshot: next });
    expect(service.accept).toHaveBeenCalledTimes(1);
    expect(() => handlers.get(IPC.TERMS_GET)!(eventFor("https://example.com"))).toThrow("Untrusted");
    expect(() => handlers.get(IPC.TERMS_ACCEPT)!(eventFor("https://example.com"), request)).toThrow("Untrusted");
    expect(service.accept).toHaveBeenCalledTimes(1);
  });
});

it("被篡改的已签发快照不能接受，正确快照通过 IPC 写入并在重启后恢复回执", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { createTermsService } = await import("./terms-service");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-terms-ipc-"));
  const service = createTermsService({
    cachePath: path.join(root, "cache.json"), consentPath: path.join(root, "receipt.json"),
    readLegacyConsent: () => "", broadcast: vi.fn(),
  });
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerTermsIpc({ ipc: { handle: (key, fn) => { handlers.set(key, fn); }, on() {}, dispose() {}, removeHandler() {} }, service });
    const event = eventFor();
    const shown = handlers.get(IPC.TERMS_GET)!(event);
    const request = { revision: shown.revision, consentVersion: shown.consentVersion, contentHash: shown.contentHash };
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, { ...request, contentHash: "changed-while-reading" })).toMatchObject({ ok: false, error: "changed" });
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    expect(handlers.get(IPC.TERMS_ACCEPT)!(event, request)).toMatchObject({ ok: true, snapshot: { accepted: true } });
    const reloaded = createTermsService({
      cachePath: path.join(root, "cache.json"), consentPath: path.join(root, "receipt.json"),
      readLegacyConsent: () => "", broadcast: vi.fn(),
    });
    expect(reloaded.getSnapshot()).toMatchObject({ accepted: true, contentHash: request.contentHash });
    reloaded.dispose();
  } finally {
    service.dispose();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
