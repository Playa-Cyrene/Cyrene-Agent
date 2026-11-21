import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../../shared/ipc-channels";
import type { TermsAcceptance, TermsAcceptResult, TermsSnapshot } from "../../shared/terms-types";
import type { IpcScope } from "../application/ipc-scope";
import { isDev } from "../env";

/** 只向应用的 React 顶层页面提供条款，不信任网页面板或同路径的远端页面。 */
export function isTrustedTermsPage(raw: string, appPath: string, development: boolean): boolean {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    if (development && url.href === "http://localhost:5173/react/") return true;
    return url.href === pathToFileURL(path.join(appPath, "dist", "renderer", "react", "index.html")).href;
  } catch { return false; }
}

export function isTrustedTermsSender(event: IpcMainInvokeEvent): boolean {
  const sender = event.sender;
  if (sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) return false;
  const owner = BrowserWindow.fromWebContents(sender);
  return Boolean(owner && !owner.isDestroyed()
    && isTrustedTermsPage(sender.getURL(), app.getAppPath(), isDev)
    && isTrustedTermsPage(event.senderFrame.url, app.getAppPath(), isDev));
}

export function broadcastTermsSnapshot(snapshot: TermsSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      if (isTrustedTermsPage(window.webContents.getURL(), app.getAppPath(), isDev)) {
        window.webContents.send(IPC.TERMS_UPDATED, snapshot);
      }
    } catch (error) {
      // 窗口关闭与广播可并发；单个失效窗口不能阻止其他窗口刷新或主进程门禁收尾。
      console.warn("[Terms] window broadcast failed:", error);
    }
  }
}

export function registerTermsIpc(options: {
  ipc: IpcScope;
  service: { getSnapshot(): TermsSnapshot; accept(request: unknown): TermsAcceptResult };
  isTrustedSender?: (event: IpcMainInvokeEvent) => boolean;
}): void {
  const authorize = options.isTrustedSender ?? isTrustedTermsSender;
  const issued = new WeakMap<object, TermsAcceptance>();
  function assertSender(event: IpcMainInvokeEvent): void {
    if (!authorize(event)) throw new Error("Untrusted terms IPC sender");
  }
  options.ipc.handle(IPC.TERMS_GET, (event: IpcMainInvokeEvent) => {
    assertSender(event);
    const snapshot = options.service.getSnapshot();
    issued.set(event.sender, {
      revision: snapshot.revision, consentVersion: snapshot.consentVersion, contentHash: snapshot.contentHash,
    });
    return snapshot;
  });
  options.ipc.handle(IPC.TERMS_ACCEPT, (event: IpcMainInvokeEvent, request: unknown) => {
    assertSender(event);
    const shown = issued.get(event.sender);
    const candidate = request as Partial<TermsAcceptance> | null;
    if (!shown || !candidate || candidate.revision !== shown.revision
      || candidate.consentVersion !== shown.consentVersion || candidate.contentHash !== shown.contentHash) {
      return { ok: false, error: "changed", snapshot: options.service.getSnapshot() } satisfies TermsAcceptResult;
    }
    const result = options.service.accept(request);
    if (result.ok) issued.delete(event.sender);
    return result;
  });
}
