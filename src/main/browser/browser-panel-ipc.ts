import type { BrowserWindow, WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { BrowserPanelBounds } from "../../shared/browser-panel-types";
import type { IpcScope } from "../application/ipc-scope";
import { BrowserPanelController } from "./browser-panel-controller";
import { registerBrowserPageTools } from "./browser-page-tools";
import { setBrowserPanelController } from "./browser-panel-runtime";
import { normalizeAddressInput } from "./address-input";
import type { LearnExamRecord } from "../../shared/learn-exam";

const EXAM_ID_PATTERN = /^exam-[0-9a-f-]{36}$/i;

function readBounds(input: unknown): BrowserPanelBounds | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<BrowserPanelBounds>;
  if (![value.x, value.y, value.width, value.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: Math.max(0, value.x!),
    y: Math.max(0, value.y!),
    width: Math.max(0, value.width!),
    height: Math.max(0, value.height!),
  };
}

export function registerBrowserPanelIpc(input: {
  ipc: IpcScope;
  getWindow: () => BrowserWindow | null;
  getExamRecord?: (examId: string) => Promise<LearnExamRecord | null>;
}): BrowserPanelController {
  const controller = new BrowserPanelController(input.getWindow, (state) => {
    const win = input.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.BROWSER_PANEL_STATE_CHANGED, state);
  }, (element) => {
    const win = input.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.BROWSER_PANEL_ELEMENT_SELECTED, element);
  });
  setBrowserPanelController(controller);
  controller.setOpenPanelForControl(() => {
    const win = input.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.BROWSER_PANEL_OPEN_FOR_CONTROL);
  });
  registerBrowserPageTools(controller);
  const authorized = (event: { sender: WebContents }) => {
    const win = input.getWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  };

  input.ipc.handle(IPC.BROWSER_PANEL_GET_STATE, async (event) => {
    if (!authorized(event)) return null;
    await controller.ready();
    return controller.getState();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_SET_BOUNDS, (event, payload: unknown) => {
    if (!authorized(event)) return false;
    if (payload === null) {
      controller.setBounds(null);
      return true;
    }
    const bounds = readBounds(payload);
    if (!bounds) return false;
    controller.setBounds(bounds);
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_NAVIGATE, (event, inputUrl: unknown) => {
    if (!authorized(event) || typeof inputUrl !== "string") return { ok: false, error: "unavailable" };
    // 地址栏手输地址允许省略协议；Agent 工具走 openInNewTab 等路径，仍要求完整 URL
    return controller.navigate(normalizeAddressInput(inputUrl));
  });
  input.ipc.handle(IPC.BROWSER_PANEL_BACK, (event) => {
    if (!authorized(event)) return false;
    controller.goBack();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_FORWARD, (event) => {
    if (!authorized(event)) return false;
    controller.goForward();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_RELOAD, (event) => {
    if (!authorized(event)) return false;
    controller.reload();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_STOP, (event) => {
    if (!authorized(event)) return false;
    controller.stop();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_NEW_TAB, (event) => {
    if (!authorized(event)) return false;
    return controller.newTab();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_OPEN_IN_NEW_TAB, (event, url: unknown) => {
    if (!authorized(event) || typeof url !== "string") return { ok: false, error: "unavailable" };
    return controller.openInNewTab(url);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_OPEN_EXAM, async (event, payload: unknown) => {
    if (!authorized(event) || !payload || typeof payload !== "object" || !input.getExamRecord) return false;
    const { examId, conversationId } = payload as { examId?: unknown; conversationId?: unknown };
    if (typeof examId !== "string" || !EXAM_ID_PATTERN.test(examId) || typeof conversationId !== "string") return false;
    const record = await input.getExamRecord(examId);
    if (!record || record.conversationId !== conversationId) return false;
    return controller.openExam(record.examId, record.conversationId);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_ACTIVATE_TAB, (event, tabId: unknown) => {
    if (!authorized(event) || typeof tabId !== "string") return false;
    return controller.activateTab(tabId);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_CLOSE_TAB, (event, tabId: unknown) => {
    if (!authorized(event) || typeof tabId !== "string") return false;
    return controller.closeTab(tabId);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_START_ELEMENT_PICKER, (event) => {
    if (!authorized(event)) return false;
    return controller.startElementPicker();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_CANCEL_ELEMENT_PICKER, (event) => {
    if (!authorized(event)) return false;
    return controller.cancelElementPicker();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_CLEAR_COOKIES, async (event) => {
    if (!authorized(event)) return { ok: false, error: "unavailable" };
    try {
      await controller.clearCookies();
      return { ok: true };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });
  return controller;
}
