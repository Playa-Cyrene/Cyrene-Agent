import { randomUUID } from "node:crypto";
import { app, Menu, session, WebContentsView, type BrowserWindow, type Session, type WebContents } from "electron";
import * as path from "node:path";
import {
  type BrowserPanelBounds,
  type BrowserElementSelection,
  type BrowserPanelResult,
  type BrowserPanelState,
  type BrowserPanelTabState,
} from "../../shared/browser-panel-types";
import { getLocaleContext } from "../locale-context";
import { allowInternalNavigation } from "../windows/external-link";
import { BrowserSessionPersistence } from "./browser-session-persistence";
import { getLearnExamPageSession } from "../protocols/bootstrap";
import { parseLearnExamPageRequest } from "../protocols/learn-exam-page-protocol";
import { registerExamPageSource } from "../learn/exam-page-authority";
import { appendBrowserObservationLog } from "./browser-observation-log";
import { navigationErrorCode, parseHttpUrl } from "./http-url";
import {
  capturePlaywrightPageSnapshot,
  cancelPlaywrightElementPicker,
  readPlaywrightElementPicker,
  resetPlaywrightPageSnapshot,
  startPlaywrightElementPicker,
  validatePlaywrightSnapshotTarget,
  type RuntimeSnapshot,
} from "./playwright-page-snapshot";

const BROWSER_PARTITION = "persist:cyrene-right-browser";
const MAX_LIVE_TAB_VIEWS = 3;
const EXAM_ID_PATTERN = /^exam-[0-9a-f-]{36}$/i;
const EMPTY_TAB_STATE = {
  kind: "web",
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
} as const;

interface BrowserTab {
  id: string;
  kind: "web" | "exam";
  lastActivationOrder: number;
  examConversationId?: string;
  unregisterExamPage?: () => void;
  view: WebContentsView | null;
  state: BrowserPanelTabState;
}

interface BrowserObservationRecord {
  tabId: string;
  url: string;
  snapshot: RuntimeSnapshot;
}

function normalizeFaviconUrl(input: string, pageUrl: string): string | undefined {
  if (input.length > 32_768) return undefined;
  if (/^data:image\/(?:svg\+xml|png|webp|gif|x-icon|vnd\.microsoft\.icon)[;,]/i.test(input)) return input;
  try {
    const url = new URL(input, pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export class BrowserPanelController {
  private tabs: BrowserTab[] = [];
  private activeTabId = "";
  private activationSequence = 0;
  private browserSession: Session | null = null;
  private parentWindow: BrowserWindow | null = null;
  private bounds: BrowserPanelBounds | null = null;
  private disposed = false;
  private initialized = false;
  private readyPromise: Promise<void>;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private elementPickerTabId = "";
  private elementPickerTimer: ReturnType<typeof setTimeout> | null = null;
  private elementPickerBusy = false;
  private readonly observations = new Map<string, BrowserObservationRecord>();
  private readonly sessionPersistence = new BrowserSessionPersistence();
  private controlLease: { conversationId: string; tabId: string } | null = null;
  private openPanelForControl: (() => void) | null = null;
  private visibleBoundsWaiters = new Set<() => void>();
  private controlAction: "starting" | "opening" | "switching" | "clicking" | "filling" | "pressing" | "scrolling" | "screenshot" | "active" | undefined;
  private controlActionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly observedWindows = new WeakSet<BrowserWindow>();
  private readonly onPlaywrightSnapshotNavigation = (contents: WebContents): void => {
    resetPlaywrightPageSnapshot(contents);
  };
  private readonly onStateChanged: (state: BrowserPanelState) => void;
  private readonly onElementSelected: (element: BrowserElementSelection) => void;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(
    getWindow: () => BrowserWindow | null,
    onStateChanged: (state: BrowserPanelState) => void,
    onElementSelected: (element: BrowserElementSelection) => void,
  ) {
    this.getWindow = getWindow;
    this.onStateChanged = onStateChanged;
    this.onElementSelected = onElementSelected;
    this.createTab(true);
    this.readyPromise = this.restoreSession();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  persistSessionForShutdown(): Promise<void> {
    return this.persistSession();
  }

  getState(): BrowserPanelState {
    return {
      activeTabId: this.activeTabId,
      elementPickerActive: this.elementPickerTabId === this.activeTabId,
      ...(this.controlLease ? { controlTabId: this.controlLease.tabId } : {}),
      ...(this.controlAction ? { controlAction: this.controlAction } : {}),
      tabs: this.tabs.map((tab) => ({ ...tab.state })),
    };
  }

  setOpenPanelForControl(handler: (() => void) | null): void {
    this.openPanelForControl = handler;
  }

  async startControl(input: { conversationId?: string; runId?: string; tabId?: string }): Promise<string> {
    await this.readyPromise;
    if (!input.conversationId || !input.runId) return "浏览器控制需要有效的 conversationId 和 runId。";
    if (this.controlLease) {
      if (this.controlLease.conversationId !== input.conversationId) {
        return "右侧浏览器正由另一个任务控制。请等该任务退出后重试。";
      }
      return `浏览器控制已开启，绑定标签 ${this.controlLease.tabId}。`;
    }
    const tab = input.tabId ? this.tabs.find((candidate) => candidate.id === input.tabId) : this.getActiveTab();
    if (!tab) return "找不到要绑定的浏览器标签。";
    if (tab.kind === "exam") return "考试答题页不能作为外部网页控制目标。请先切换到普通网页标签。";
    this.controlLease = { conversationId: input.conversationId, tabId: tab.id };
    this.setControlAction("starting");
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      const visible = new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.visibleBoundsWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 8_000);
        this.visibleBoundsWaiters.add(finish);
      });
      this.openPanelForControl?.();
      await visible;
    }
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      this.controlLease = null;
      this.setControlAction(undefined);
      return "右侧浏览器面板未能显示，请先打开浏览器标签后重试。";
    }
    if (tab.id !== this.activeTabId) this.activateTab(tab.id);
    if (!tab.view) {
      try { this.ensureView(tab); }
      catch {
        this.controlLease = null;
        this.setControlAction(undefined);
        return "右侧网页视图初始化失败，浏览器控制没有启动。";
      }
    }
    this.setControlAction("active");
    return `浏览器控制已开启，绑定标签 ${tab.id}。后续网页操作只作用于这个可见标签。`;
  }

  stopControl(conversationId?: string, _runId?: string): string {
    if (!this.controlLease) return "当前没有浏览器控制会话。";
    if (this.controlLease.conversationId !== conversationId) {
      return "当前任务不持有浏览器控制权，未执行退出操作。";
    }
    this.controlLease = null;
    this.setControlAction(undefined);
    return "浏览器控制已退出；网页标签和登录状态保留。";
  }

  private setControlAction(action: BrowserPanelState["controlAction"]): void {
    if (this.controlActionTimer) clearTimeout(this.controlActionTimer);
    this.controlActionTimer = null;
    this.controlAction = action;
    if (action && action !== "active") {
      this.controlActionTimer = setTimeout(() => {
        if (this.controlAction === action) {
          this.controlAction = "active";
          this.publish();
        }
      }, 2_000);
    }
    this.publish();
  }

  getControlState(conversationId?: string, runId?: string): "active" | "inactive" {
    return this.matchesControlOwner(conversationId, runId) ? "active" : "inactive";
  }

  hasActiveControl(): boolean {
    return this.controlLease !== null;
  }

  private matchesControlOwner(conversationId?: string, _runId?: string): boolean {
    return !!this.controlLease
      && this.controlLease.conversationId === conversationId;
  }

  private assertControl(conversationId?: string, runId?: string): { ok: true; tab: BrowserTab; contents: WebContents } | { ok: false; reason: string } {
    if (!this.matchesControlOwner(conversationId, runId) || !this.controlLease) {
      return { ok: false, reason: "当前任务没有有效的浏览器控制会话。请先调用 browser_control_start。" };
    }
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      return { ok: false, reason: "右侧浏览器当前已隐藏，操作已暂停。重新打开浏览器面板后再试。" };
    }
    if (this.activeTabId !== this.controlLease.tabId) {
      return { ok: false, reason: "右侧浏览器已切换到其他标签。请调用 browser_select_tab 明确选择控制目标。" };
    }
    const tab = this.tabs.find((candidate) => candidate.id === this.controlLease?.tabId);
    const contents = tab?.view?.webContents;
    if (!tab || !contents || contents.isDestroyed()) return { ok: false, reason: "绑定的浏览器标签已关闭。请重新选择标签。" };
    if (tab.state.loading || contents.isLoading()) return { ok: false, reason: "网页仍在加载，请等页面完成后重试。" };
    return { ok: true, tab, contents };
  }

  async controlOpenUrl(input: { conversationId?: string; runId?: string; url: string; newTab?: boolean }): Promise<string> {
    const checked = this.assertControl(input.conversationId, input.runId);
    if (!checked.ok) return checked.reason;
    this.setControlAction("opening");
    const result = input.newTab
      ? await this.openInNewTab(input.url)
      : await this.navigateTab(checked.tab, input.url);
    if (!result.ok) return `打开网页失败：${result.error}。只支持完整的 HTTP 或 HTTPS 地址。`;
    if (input.newTab && this.controlLease) this.controlLease.tabId = this.activeTabId;
    const active = this.getActiveTab();
    return JSON.stringify({ web: active?.state.url ?? input.url, tabId: active?.id, title: active?.state.title ?? "", status: active?.state.loading ? "loading" : "loaded" });
  }

  controlListTabs(conversationId?: string, runId?: string): string {
    if (!this.matchesControlOwner(conversationId, runId)) return "当前任务没有浏览器控制权。";
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) return "右侧浏览器当前已隐藏，请重新打开后再列出标签。";
    return JSON.stringify(this.tabs.map(({ id, state }) => ({ tabId: id, url: state.url, title: state.title, loading: state.loading, active: id === this.activeTabId })));
  }

  controlSelectTab(input: { conversationId?: string; runId?: string; tabId: string }): string {
    if (!this.matchesControlOwner(input.conversationId, input.runId) || !this.controlLease) return "当前任务没有浏览器控制权。";
    if (!this.tabs.some((tab) => tab.id === input.tabId)) return "找不到该标签页。请先调用 browser_list_tabs。";
    this.setControlAction("switching");
    this.controlLease.tabId = input.tabId;
    if (!this.activateTab(input.tabId)) return "切换标签失败。";
    return `已绑定标签 ${input.tabId}。请重新读取页面元素后再操作。`;
  }

  async controlClick(input: { conversationId?: string; runId?: string; observationId: string; ref: string }): Promise<string> {
    const checked = this.resolveControlTarget(input);
    if (!checked.ok) return checked.reason;
    this.setControlAction("clicking");
    const hit = await this.validateTargetAt(checked.contents, checked.target, input.observationId);
    if (!hit.ok) return hit.reason;
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return "Cyrene 窗口当前未获得焦点。已暂停浏览器操作，请先点回 Cyrene 窗口。";
    checked.contents.sendInputEvent({ type: "mouseMove", x: hit.x, y: hit.y });
    checked.contents.sendInputEvent({ type: "mouseDown", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    checked.contents.sendInputEvent({ type: "mouseUp", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    this.observations.delete(input.observationId);
    return `已点击 ${input.ref}（${checked.target.description}）。页面可能发生变化；请重新读取页面元素。`;
  }

  async controlFill(input: { conversationId?: string; runId?: string; observationId: string; ref: string; value: string }): Promise<string> {
    const checked = this.resolveControlTarget(input);
    if (!checked.ok) return checked.reason;
    const sensitive = this.isSensitiveInput(checked.target);
    if (sensitive) return `拒绝代理填写 ${input.ref}：疑似密码、一次性验证码或支付字段，请由用户手动输入。`;
    this.setControlAction("filling");
    const hit = await this.validateTargetAt(checked.contents, checked.target, input.observationId);
    if (!hit.ok) return hit.reason;
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return "Cyrene 窗口当前未获得焦点。已暂停浏览器操作，请先点回 Cyrene 窗口。";
    checked.contents.sendInputEvent({ type: "mouseMove", x: hit.x, y: hit.y });
    checked.contents.sendInputEvent({ type: "mouseDown", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    checked.contents.sendInputEvent({ type: "mouseUp", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    checked.contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
    checked.contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
    checked.contents.insertText(input.value);
    this.observations.delete(input.observationId);
    return `已向 ${input.ref} 填入文本。页面可能发生变化；请重新读取页面元素。`;
  }

  async controlPress(input: { conversationId?: string; runId?: string; key: string; observationId?: string; ref?: string }): Promise<string> {
    const checked = this.assertControl(input.conversationId, input.runId);
    if (!checked.ok) return checked.reason;
    this.setControlAction("pressing");
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return "Cyrene 窗口当前未获得焦点。已暂停浏览器操作，请先点回 Cyrene 窗口。";
    const keys: Record<string, string> = { Enter: "ENTER", Escape: "ESC", Tab: "TAB", ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT", Backspace: "BACKSPACE", Delete: "DELETE", Space: "SPACE" };
    const keyCode = keys[input.key];
    if (!keyCode) return "不支持该按键。可用：Enter、Escape、Tab、方向键、Backspace、Delete、Space。";
    if (input.ref || input.observationId) {
      if (!input.ref || !input.observationId) return "指定元素时必须同时传 observationId 和 ref。";
      const target = this.resolveControlTarget({ ...input, observationId: input.observationId, ref: input.ref });
      if (!target.ok) return target.reason;
      const hit = await this.validateTargetAt(target.contents, target.target, input.observationId);
      if (!hit.ok) return hit.reason;
      target.contents.sendInputEvent({ type: "mouseDown", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
      target.contents.sendInputEvent({ type: "mouseUp", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
      this.observations.delete(input.observationId);
    }
    checked.contents.sendInputEvent({ type: "keyDown", keyCode });
    checked.contents.sendInputEvent({ type: "keyUp", keyCode });
    if (input.observationId) this.observations.delete(input.observationId);
    return `已按下 ${input.key}。页面可能发生变化；请重新读取页面元素。`;
  }

  async controlScroll(input: { conversationId?: string; runId?: string; direction: "up" | "down"; amount?: number; observationId?: string; ref?: string }): Promise<string> {
    let checked = this.assertControl(input.conversationId, input.runId);
    if (!checked.ok) return checked.reason;
    this.setControlAction("scrolling");
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return "Cyrene 窗口当前未获得焦点。已暂停浏览器操作，请先点回 Cyrene 窗口。";
    let x = Math.floor(this.bounds!.width / 2);
    let y = Math.floor(this.bounds!.height / 2);
    if (input.ref || input.observationId) {
      if (!input.ref || !input.observationId) return "指定滚动容器时必须同时传 observationId 和 ref。";
      const target = this.resolveControlTarget({ ...input, observationId: input.observationId, ref: input.ref });
      if (!target.ok) return target.reason;
      const hit = await this.validateTargetAt(target.contents, target.target, input.observationId);
      if (!hit.ok) return hit.reason;
      x = hit.x;
      y = hit.y;
      checked = { ok: true, tab: target.tab, contents: target.contents };
    }
    const amount = Math.max(80, Math.min(1200, Math.floor(input.amount ?? 600))) * (input.direction === "down" ? 1 : -1);
    checked.contents.sendInputEvent({ type: "mouseWheel", x, y, deltaY: amount });
    if (input.observationId) this.observations.delete(input.observationId);
    return `已向${input.direction === "down" ? "下" : "上"}滚动页面。请重新读取页面元素。`;
  }

  async captureControlScreenshot(input: { conversationId?: string; runId?: string }): Promise<{ ok: true; base64: string; width: number; height: number; url: string; tabId: string } | { ok: false; reason: string }> {
    const checked = this.assertControl(input.conversationId, input.runId);
    if (!checked.ok) return checked;
    this.setControlAction("screenshot");
    if (!checked.tab.state.url) return { ok: false, reason: "当前标签还没有打开网页。" };
    if (checked.contents.isLoading()) return { ok: false, reason: "网页仍在加载。" };
    if (this.elementPickerTabId === checked.tab.id) return { ok: false, reason: "网页元素选择工具正在运行，请先结束选择后截图。" };
    const image = await checked.contents.capturePage();
    if (image.isEmpty()) return { ok: false, reason: "当前网页视口截图为空。" };
    const size = image.getSize();
    if (size.width * size.height > 16_000_000) return { ok: false, reason: "网页截图超过 1600 万像素，已停止传输。" };
    const png = image.toPNG();
    if (png.byteLength > 8 * 1024 * 1024) return { ok: false, reason: "网页截图超过 8 MB，已停止传输。" };
    return { ok: true, base64: png.toString("base64"), width: size.width, height: size.height, url: checked.tab.state.url, tabId: checked.tab.id };
  }

  private resolveControlTarget(input: { conversationId?: string; runId?: string; observationId: string; ref: string }):
    | { ok: true; tab: BrowserTab; contents: WebContents; target: RuntimeSnapshot["elements"][number] }
    | { ok: false; reason: string } {
    const checked = this.assertControl(input.conversationId, input.runId);
    if (!checked.ok) return checked;
    const observation = this.observations.get(input.observationId);
    if (!observation || observation.tabId !== checked.tab.id || observation.url !== checked.tab.state.url) {
      return { ok: false, reason: "页面观察已过期或来自其他标签。请重新调用 browser_get_page_elements。" };
    }
    const target = observation.snapshot.elements.find((element) => element.ref === input.ref);
    if (!target) return { ok: false, reason: `当前观察 ${input.observationId} 中找不到 ${input.ref}。请重新读取页面。` };
    if (!target.inViewport || target.disabled || target.bounds[2] <= 0 || target.bounds[3] <= 0) {
      return { ok: false, reason: `${input.ref} 当前不可见或已禁用。请滚动后重新读取页面。` };
    }
    return { ...checked, target };
  }

  private async validateTargetAt(contents: WebContents, target: RuntimeSnapshot["elements"][number], observationId: string): Promise<{ ok: true; x: number; y: number } | { ok: false; reason: string }> {
    const [x, y, width, height] = target.bounds;
    try {
      const valid = await validatePlaywrightSnapshotTarget(contents, {
        observationId,
        ref: target.ref,
        description: target.description,
        x: x + width / 2,
        y: y + height / 2,
      });
      if (valid.ok && Number.isFinite(valid.x) && Number.isFinite(valid.y)) return { ok: true, x: valid.x!, y: valid.y! };
      return { ok: false, reason: `无法确认 ${target.ref} 仍是快照中的同一个可见 DOM 元素，已拒绝操作。请重新读取页面。` };
    } catch (error) {
      return { ok: false, reason: `验证网页元素失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private isSensitiveInput(target: RuntimeSnapshot["elements"][number]): boolean {
    const values = Object.entries(target.attributes).map(([name, value]) => `${name}=${value}`).join(" ").toLowerCase();
    return /type=password|one-time-code|current-password|new-password|password|passwd|otp|verification|security.?code|credit.?card|card.?number|cvv|cvc|payment/i.test(values);
  }

  async startElementPicker(): Promise<boolean> {
    await this.readyPromise;
    if (this.getActiveTab()?.kind === "exam") return false;
    const tab = this.getActiveTab();
    const contents = tab?.view?.webContents;
    if (!tab || !contents || contents.isDestroyed() || contents.isLoading() || !tab.state.url
      || !this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) return false;
    this.cancelElementPicker();
    try {
      const snapshot = await startPlaywrightElementPicker(contents);
      if (this.getActiveTab()?.id !== tab.id || tab.state.loading || contents.isDestroyed()) {
        if (!contents.isDestroyed()) await cancelPlaywrightElementPicker(contents).catch(() => undefined);
        return false;
      }
      this.elementPickerTabId = tab.id;
      this.publish();
      this.rememberObservation(tab, snapshot);
      await appendBrowserObservationLog({ tabId: tab.id, url: tab.state.url, snapshot }).catch((error) => {
        console.warn("[BrowserPanel] 记录元素选择快照失败", error);
      });
      if (this.elementPickerTabId !== tab.id) return false;
      this.scheduleElementPickerPoll();
      return true;
    } catch (error) {
      console.warn("[BrowserPanel] 启动网页元素选择失败", error);
      this.elementPickerTabId = "";
      this.publish();
      return false;
    }
  }

  cancelElementPicker(): boolean {
    const tabId = this.elementPickerTabId;
    if (!tabId) return false;
    this.elementPickerTabId = "";
    if (this.elementPickerTimer) clearTimeout(this.elementPickerTimer);
    this.elementPickerTimer = null;
    const contents = this.tabs.find((tab) => tab.id === tabId)?.view?.webContents;
    if (contents && !contents.isDestroyed()) void cancelPlaywrightElementPicker(contents).catch(() => undefined);
    this.publish();
    return true;
  }

  private scheduleElementPickerPoll(): void {
    if (!this.elementPickerTabId || this.disposed) return;
    this.elementPickerTimer = setTimeout(() => void this.pollElementPicker(), 100);
  }

  private async pollElementPicker(): Promise<void> {
    if (this.elementPickerBusy || !this.elementPickerTabId || this.disposed) return;
    this.elementPickerBusy = true;
    const tabId = this.elementPickerTabId;
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    const contents = tab?.view?.webContents;
    try {
      if (!tab || !contents || contents.isDestroyed()) {
        this.finishElementPicker(tabId);
        return;
      }
      const state = await readPlaywrightElementPicker(contents);
      if (this.elementPickerTabId !== tabId) return;
      if (state.selected) {
        this.finishElementPicker(tabId);
        this.onElementSelected({
          ...state.selected,
          tabId,
          pageUrl: tab.state.url,
          pageTitle: tab.state.title,
        });
        return;
      }
      if (state.cancelled || !state.active) {
        this.finishElementPicker(tabId);
        return;
      }
    } catch (error) {
      console.warn("[BrowserPanel] 网页元素选择轮询失败", error);
      this.finishElementPicker(tabId);
      return;
    } finally {
      this.elementPickerBusy = false;
    }
    this.scheduleElementPickerPoll();
  }

  private finishElementPicker(tabId: string): void {
    if (this.elementPickerTabId !== tabId) return;
    this.elementPickerTabId = "";
    if (this.elementPickerTimer) clearTimeout(this.elementPickerTimer);
    this.elementPickerTimer = null;
    this.publish();
  }

  async getActivePageSnapshot(owner?: { conversationId?: string; runId?: string }): Promise<
    | { ok: true; snapshot: RuntimeSnapshot }
    | { ok: false; reason: string }
  > {
    await this.readyPromise;
    if (this.controlLease && !this.matchesControlOwner(owner?.conversationId, owner?.runId)) {
      return { ok: false, reason: "右侧浏览器正由另一个任务控制，当前任务不能读取页面。" };
    }
    if (this.matchesControlOwner(owner?.conversationId, owner?.runId) && this.activeTabId !== this.controlLease?.tabId) {
      return { ok: false, reason: "浏览器当前显示的标签与控制绑定不一致。请先调用 browser_select_tab 选择目标。" };
    }
    const tab = this.getActiveTab();
    if (tab?.kind === "exam") return { ok: false, reason: "当前标签是应用内考试答题页，浏览器页面元素工具只支持普通网页。" };
    const contents = tab?.view?.webContents;
    const hasVisibleBounds = !!this.bounds && this.bounds.width > 0 && this.bounds.height > 0;
    const contentsDestroyed = contents ? contents.isDestroyed() : null;
    const contentsLoading = contents && !contentsDestroyed ? contents.isLoading() : null;
    const hasPageUrl = !!tab?.state.url;
    if (!hasVisibleBounds || !hasPageUrl || !contents || contentsDestroyed || contentsLoading) {
      const reasons = [
        !hasVisibleBounds ? "右侧浏览器面板当前没有可见区域" : "",
        !tab ? "找不到当前选中的标签页" : "",
        !hasPageUrl ? "当前选中的标签页为空，尚无网页地址" : "",
        tab && !tab.view ? "当前标签页的网页视图尚未创建" : "",
        contentsDestroyed ? "当前标签页的网页进程已关闭" : "",
        contentsLoading ? "当前标签页仍在加载" : "",
      ].filter(Boolean);
      console.warn("[BrowserPanel] 无法读取当前标签页", {
        activeTabId: this.activeTabId || null,
        tabCount: this.tabs.length,
        activeTabFound: !!tab,
        activeTabHasUrl: hasPageUrl,
        activeTabHasView: !!tab?.view,
        tabs: this.tabs.map((candidate) => ({
          id: candidate.id,
          active: candidate.id === this.activeTabId,
          hasUrl: !!candidate.state.url,
          hasView: !!candidate.view,
          loading: candidate.state.loading,
          crashed: candidate.state.crashed,
        })),
        browserBounds: this.bounds
          ? { width: this.bounds.width, height: this.bounds.height }
          : null,
        contentsDestroyed,
        contentsLoading,
      });
      return { ok: false, reason: reasons.join("；") };
    }
    try {
      const snapshot = await capturePlaywrightPageSnapshot(contents);
      this.rememberObservation(tab, snapshot);
      await appendBrowserObservationLog({ tabId: tab.id, url: tab.state.url, snapshot });
      return { ok: true, snapshot };
    } catch (error) {
      console.warn("[BrowserPanel] Playwright 页面识别失败", {
        activeTabId: this.activeTabId || null,
        tabCount: this.tabs.length,
        error,
      });
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `Playwright 页面识别失败：${reason}` };
    }
  }

  async getElementCss(input: { ref: string; observationId: string; tabId?: string }, owner?: { conversationId?: string; runId?: string }): Promise<string> {
    await this.readyPromise;
    const observation = this.observations.get(input.observationId);
    if (this.controlLease && !this.matchesControlOwner(owner?.conversationId, owner?.runId)) {
      return "右侧浏览器正由另一个任务控制，当前任务不能读取其元素样式。";
    }
    if (this.matchesControlOwner(owner?.conversationId, owner?.runId) && observation?.tabId !== this.controlLease?.tabId) {
      return "这个快照不属于当前控制标签。请读取绑定标签的页面后重试。";
    }
    if (!observation || (input.tabId && input.tabId !== observation.tabId)) {
      return "找不到这个页面快照。请重新读取当前页面元素，再用新返回的 observationId 和 ref 查询样式。";
    }
    if (observation.tabId !== this.activeTabId) {
      return "这个快照来自另一个标签页。请先切换到对应标签页，再重新读取页面元素并查询 CSS。";
    }
    const tab = this.tabs.find((candidate) => candidate.id === observation.tabId);
    const contents = tab?.view?.webContents;
    if (!tab || !contents || contents.isDestroyed() || contents.isLoading() || tab.state.url !== observation.url) {
      return "这个元素快照已经过期（页面已切换、正在加载或标签页已关闭）。请重新读取页面元素后再查询。";
    }
    const target = observation.snapshot.elements.find((element) => element.ref === input.ref);
    if (!target) return `快照 ${input.observationId} 中没有 ref=${input.ref}。请确认 ref 与 observationId 来自同一次页面读取。`;
    if (!target.inViewport || target.bounds[2] <= 0 || target.bounds[3] <= 0) {
      return `ref=${input.ref} 当前不在可见区域，无法安全映射到 CSS 节点。先滚动到该元素可见位置，再重新读取页面。`;
    }

    const debuggerApi = contents.debugger;
    const attachedByThisCall = !debuggerApi.isAttached();
    try {
      if (attachedByThisCall) debuggerApi.attach();
      await debuggerApi.sendCommand("DOM.enable");
      // CDP requires the document tree to be requested before node hit-testing
      // and CSS inspection commands can operate on nodes.
      await debuggerApi.sendCommand("DOM.getDocument", { depth: 0, pierce: true });
      await debuggerApi.sendCommand("CSS.enable");
      const [x, y, width, height] = target.bounds;
      const insetX = Math.max(1, Math.min(4, Math.floor(width / 4)));
      const insetY = Math.max(1, Math.min(4, Math.floor(height / 4)));
      const points = [
        [x + Math.floor(width / 2), y + Math.floor(height / 2)],
        [x + insetX, y + insetY],
        [x + width - insetX, y + insetY],
        [x + insetX, y + height - insetY],
        [x + width - insetX, y + height - insetY],
      ];
      let matchedNode: Record<string, unknown> | undefined;
      let matchedNodeId: number | undefined;
      for (const [pointX, pointY] of points) {
        const location = await debuggerApi.sendCommand("DOM.getNodeForLocation", {
          x: pointX,
          y: pointY,
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: false,
        }) as { backendNodeId?: number; nodeId?: number };
        let nodeId = location.nodeId;
        if (!nodeId && typeof location.backendNodeId === "number") {
          const pushed = await debuggerApi.sendCommand("DOM.pushNodesByBackendIdsToFrontend", {
            backendNodeIds: [location.backendNodeId],
          }) as { nodeIds?: number[] };
          nodeId = pushed.nodeIds?.[0];
        }
        if (!nodeId) continue;
        let described = await debuggerApi.sendCommand("DOM.describeNode", { nodeId, depth: 0 }) as { node?: Record<string, unknown> };
        let candidate = described.node;
        // Hit testing may land on a text node or nested child. Walk up a few DOM levels
        // and accept only the tag/identity captured for this exact ref.
        for (let depth = 0; candidate && depth <= 4; depth += 1) {
          if (this.matchesObservedElement(candidate, target)) {
            matchedNode = candidate;
            matchedNodeId = Number(candidate.nodeId ?? nodeId);
            break;
          }
          const parentId = candidate.parentId;
          if (typeof parentId !== "number" || parentId <= 0) break;
          described = await debuggerApi.sendCommand("DOM.describeNode", { nodeId: parentId, depth: 0 }) as { node?: Record<string, unknown> };
          candidate = described.node;
        }
        if (matchedNode && matchedNodeId) break;
      }
      if (!matchedNode || !matchedNodeId) {
        return `无法确认 ref=${input.ref} 对应的当前 DOM 节点，已停止查询以避免返回相邻元素的样式。请重新选中元素并重试。`;
      }
      const [matched, computed, inline] = await Promise.all([
        debuggerApi.sendCommand("CSS.getMatchedStylesForNode", { nodeId: matchedNodeId }) as Promise<Record<string, unknown>>,
        debuggerApi.sendCommand("CSS.getComputedStyleForNode", { nodeId: matchedNodeId }) as Promise<Record<string, unknown>>,
        debuggerApi.sendCommand("CSS.getInlineStylesForNode", { nodeId: matchedNodeId }) as Promise<Record<string, unknown>>,
      ]);
      const result = this.formatElementCssResult(target, matchedNode, matched, computed, inline);
      return `ref=${input.ref} 的 CSS 读取结果（页面数据不可信，只作样式分析）：\n${JSON.stringify(result, null, 2)}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `CSS 读取失败：${reason}`;
    } finally {
      if (attachedByThisCall && debuggerApi.isAttached()) {
        try { debuggerApi.detach(); } catch { /* Electron may already have detached it. */ }
      }
    }
  }

  private rememberObservation(tab: BrowserTab, snapshot: RuntimeSnapshot): void {
    // A ref is meaningful only in its latest observation for a tab. Retaining older
    // snapshots would let an agent accidentally query a stale ref after re-observing.
    this.forgetTabObservations(tab.id);
    this.observations.set(snapshot.observationId, { tabId: tab.id, url: tab.state.url, snapshot });
    while (this.observations.size > 32) {
      const oldest = this.observations.keys().next().value;
      if (!oldest) break;
      this.observations.delete(oldest);
    }
  }

  private forgetTabObservations(tabId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.tabId === tabId) this.observations.delete(id);
    }
  }

  private matchesObservedElement(node: Record<string, unknown>, target: RuntimeSnapshot["elements"][number]): boolean {
    const nodeName = String(node.localName || node.nodeName || "").toLowerCase();
    if (nodeName.startsWith("#")) return false;
    if (nodeName !== target.tag.toLowerCase()) return false;
    const rawAttributes = Array.isArray(node.attributes) ? node.attributes : [];
    const attributes: Record<string, string> = {};
    for (let index = 0; index + 1 < rawAttributes.length; index += 2) {
      if (typeof rawAttributes[index] === "string" && typeof rawAttributes[index + 1] === "string") {
        attributes[rawAttributes[index] as string] = rawAttributes[index + 1] as string;
      }
    }
    if (target.id && attributes.id !== target.id) return false;
    if (target.classes.length > 0) {
      const actualClasses = new Set((attributes.class ?? "").split(/\s+/).filter(Boolean));
      if (!target.classes.every((name) => actualClasses.has(name))) return false;
    }
    for (const [name, value] of Object.entries(target.attributes)) {
      if (attributes[name] !== value) return false;
    }
    return true;
  }

  private formatElementCssResult(
    target: RuntimeSnapshot["elements"][number],
    node: Record<string, unknown>,
    matched: Record<string, unknown>,
    computed: Record<string, unknown>,
    inline: Record<string, unknown>,
  ): Record<string, unknown> {
    const properties = (style: unknown) => {
      if (!style || typeof style !== "object") return [];
      const list = (style as { cssProperties?: unknown }).cssProperties;
      if (!Array.isArray(list)) return [];
      return list.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const property = item as Record<string, unknown>;
        if (property.disabled === true || property.parsedOk === false) return [];
        return [{
          name: String(property.name ?? ""),
          value: String(property.value ?? ""),
          ...(property.important === true ? { important: true } : {}),
        }];
      }).slice(0, 40);
    };
    const rules = Array.isArray(matched.matchedCSSRules) ? matched.matchedCSSRules : [];
    const matchedRules = rules.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rule = (item as Record<string, unknown>).rule;
      if (!rule || typeof rule !== "object") return [];
      const value = rule as Record<string, unknown>;
      const selectorList = value.selectorList as { text?: string; selectors?: Array<{ text?: string }> } | undefined;
      const sourceRange = value.range as { startLine?: number; endLine?: number } | undefined;
      return [{
        selector: selectorList?.text ?? selectorList?.selectors?.map((selector) => selector.text).filter(Boolean).join(", ") ?? "(selector unavailable)",
        origin: String(value.origin ?? "unknown"),
        ...(sourceRange && typeof sourceRange.startLine === "number" ? { startLine: sourceRange.startLine + 1 } : {}),
        declarations: properties(value.style),
      }];
    });
    const computedStyle = Array.isArray(computed.computedStyle)
      ? computed.computedStyle.slice(0, 80).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const property = item as Record<string, unknown>;
          return [{ name: String(property.name ?? ""), value: String(property.value ?? "") }];
        })
      : [];
    const inherited = Array.isArray(matched.inherited) ? matched.inherited.slice(0, 8).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const inheritedRules = Array.isArray(record.matchedCSSRules) ? record.matchedCSSRules : [];
      return [{
        ancestor: (record.inlineStyle as { cssProperties?: unknown } | undefined)?.cssProperties ? "ancestor inline styles" : "ancestor matched rules",
        rules: inheritedRules.slice(0, 8).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const rule = (item as Record<string, unknown>).rule as Record<string, unknown> | undefined;
          if (!rule) return [];
          const selectors = rule.selectorList as { text?: string } | undefined;
          return [{ selector: selectors?.text ?? "(selector unavailable)", declarations: properties(rule.style) }];
        }),
      }];
    }) : [];
    const attributes = Array.isArray(node.attributes) ? node.attributes : [];
    const identity: Record<string, string> = {};
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (typeof attributes[index] === "string" && typeof attributes[index + 1] === "string") {
        identity[attributes[index] as string] = attributes[index + 1] as string;
      }
    }
    return {
      element: { ref: target.ref, tag: String(node.localName ?? target.tag), description: target.description, attributes: identity },
      matchedRules,
      inlineStyles: properties(inline.inlineStyle),
      computedStyle,
      inherited,
      truncated: rules.length > matchedRules.length,
    };
  }

  setBounds(bounds: BrowserPanelBounds | null): void {
    this.bounds = bounds;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      for (const resolve of [...this.visibleBoundsWaiters]) resolve();
    }
    if (!this.initialized) return;
    const win = this.getWindow();
    if (this.parentWindow && this.parentWindow !== win) {
      this.destroyViews();
      this.parentWindow = null;
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.applyBounds();
      return;
    }
    const activeTab = this.getActiveTab();
    if (activeTab?.state.url && !activeTab.view) {
      try {
        this.ensureView(activeTab);
      } catch {
        activeTab.state = { ...activeTab.state, loading: false, error: "unavailable" };
        this.publish();
      }
    }
    this.applyBounds();
  }

  async navigate(input: string): Promise<BrowserPanelResult> {
    await this.readyPromise;
    const activeTab = this.getActiveTab();
    if (!activeTab) return { ok: false, error: "unavailable" };
    return this.navigateTab(activeTab, input);
  }

  async openExam(examId: string, conversationId: string): Promise<boolean> {
    await this.readyPromise;
    if (this.disposed || !EXAM_ID_PATTERN.test(examId) || !conversationId) return false;
    const existing = this.tabs.find((tab) => {
      const page = tab.kind === "exam" ? parseLearnExamPageRequest(tab.state.url) : null;
      return page?.kind === "document" && page.examId === examId;
    });
    if (existing) {
      if (existing.examConversationId !== conversationId) return false;
      this.activateTab(existing.id);
      this.openPanelForControl?.();
      return true;
    }
    const tab = this.createTab(true, { kind: "exam", examConversationId: conversationId, url: `cyrene-exam://paper/${examId}` });
    this.openPanelForControl?.();
    if (this.bounds?.width && this.bounds.height) {
      try {
        const view = this.ensureView(tab, false);
        if (!view) return false;
        await view.webContents.loadURL(tab.state.url);
      } catch {
        tab.state = { ...tab.state, loading: false, error: "load_failed" };
      }
    }
    this.applyBounds();
    this.publish();
    return true;
  }

  newTab(): boolean {
    if (this.disposed || !this.initialized) return false;
    this.createTab(true);
    this.applyBounds();
    this.publish();
    return true;
  }

  async openInNewTab(input: string): Promise<BrowserPanelResult> {
    await this.readyPromise;
    if (this.disposed) return { ok: false, error: "unavailable" };
    const url = parseHttpUrl(input);
    if (!url) return { ok: false, error: navigationErrorCode(input) };
    const tab = this.createTab(true);
    this.applyBounds();
    this.publish();
    return this.navigateTab(tab, url.href);
  }

  activateTab(tabId: string): boolean {
    if (!this.initialized) return false;
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    if (this.activeTabId !== tabId) {
      this.forgetTabObservations(this.activeTabId);
      this.forgetTabObservations(tabId);
    }
    if (this.elementPickerTabId && this.elementPickerTabId !== tabId) this.cancelElementPicker();
    this.activeTabId = tab.id;
    tab.lastActivationOrder = ++this.activationSequence;
    if (this.bounds && tab.state.url && !tab.view) {
      try {
        this.ensureView(tab);
      } catch {
        tab.state = { ...tab.state, loading: false, error: "unavailable" };
      }
    }
    this.applyBounds();
    this.publish();
    return true;
  }

  closeTab(tabId: string): boolean {
    if (!this.initialized) return false;
    const index = this.tabs.findIndex((candidate) => candidate.id === tabId);
    if (index < 0) return false;
    if (this.controlLease?.tabId === tabId) this.controlLease = null;
    if (this.elementPickerTabId === tabId) this.cancelElementPicker();
    const tab = this.tabs[index];
    this.forgetTabObservations(tabId);
    if (this.tabs.length === 1) {
      this.destroyTabView(tab);
      tab.kind = "web";
      tab.examConversationId = undefined;
      tab.state = { id: tab.id, ...EMPTY_TAB_STATE };
      this.activeTabId = tab.id;
    } else {
      this.destroyTabView(tab);
      this.tabs.splice(index, 1);
      if (this.activeTabId === tabId) {
        const nextActiveTab = this.tabs[Math.min(index, this.tabs.length - 1)];
        this.activeTabId = nextActiveTab.id;
        nextActiveTab.lastActivationOrder = ++this.activationSequence;
        if (this.bounds && nextActiveTab.state.url && !nextActiveTab.view) {
          try {
            this.ensureView(nextActiveTab);
          } catch {
            nextActiveTab.state = { ...nextActiveTab.state, loading: false, error: "unavailable" };
          }
        }
      }
    }
    this.applyBounds();
    this.publish();
    return true;
  }

  goBack(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoBack()) contents.goBack();
  }

  goForward(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoForward()) contents.goForward();
  }

  reload(): void {
    const tab = this.getActiveTab();
    const contents = tab?.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      if (tab.state.crashed) {
        tab.state = { ...tab.state, crashed: false, error: undefined };
        this.publish();
      }
      contents.reload();
    }
  }

  stop(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
  }

  async clearCookies(): Promise<void> {
    await this.readyPromise;
    const browserSession = this.getSession();
    await browserSession.clearStorageData({ storages: ["cookies"] });
    await browserSession.cookies.flushStore();
    await this.persistSession();
    for (const tab of this.tabs) {
      if (tab.kind !== "web") continue;
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed() && tab.state.url) contents.reload();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controlLease = null;
    if (this.controlActionTimer) clearTimeout(this.controlActionTimer);
    this.controlActionTimer = null;
    this.controlAction = undefined;
    for (const resolve of [...this.visibleBoundsWaiters]) resolve();
    this.visibleBoundsWaiters.clear();
    if (this.elementPickerTimer) clearTimeout(this.elementPickerTimer);
    this.elementPickerTimer = null;
    this.elementPickerTabId = "";
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.destroyViews();
    this.tabs = [];
    this.browserSession = null;
    this.parentWindow = null;
  }

  private getActiveTab(): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  private createTab(activate: boolean, options: { kind?: "web" | "exam"; url?: string; examConversationId?: string } = {}): BrowserTab {
    const id = randomUUID();
    const kind = options.kind ?? "web";
    const tab: BrowserTab = {
      id,
      kind,
      lastActivationOrder: activate || !this.activeTabId ? ++this.activationSequence : 0,
      ...(options.examConversationId ? { examConversationId: options.examConversationId } : {}),
      view: null,
      state: { id, ...EMPTY_TAB_STATE, kind, ...(options.url ? { url: options.url } : {}) },
    };
    this.tabs.push(tab);
    if (activate || !this.activeTabId) this.activeTabId = id;
    return tab;
  }

  private async navigateTab(tab: BrowserTab, input: string): Promise<BrowserPanelResult> {
    if (this.disposed || !this.tabs.includes(tab)) return { ok: false, error: "unavailable" };
    const url = parseHttpUrl(input);
    if (!url) return { ok: false, error: navigationErrorCode(input) };
    if (tab.kind === "exam") {
      tab.unregisterExamPage?.();
      tab.unregisterExamPage = undefined;
      tab.kind = "web";
      tab.examConversationId = undefined;
      if (tab.view) this.destroyTabView(tab);
      tab.state = { id: tab.id, ...EMPTY_TAB_STATE, url: url.href };
    }
    this.forgetTabObservations(tab.id);
    let view: WebContentsView | null;
    try {
      view = this.ensureView(tab, false);
    } catch {
      tab.state = { ...tab.state, loading: false, error: "unavailable" };
      this.publish();
      return { ok: false, error: "unavailable" };
    }
    if (!view) return { ok: false, error: "unavailable" };
    this.applyBounds();
    tab.state = { ...tab.state, url: url.href, error: undefined, crashed: false };
    this.publish();
    try {
      await view.webContents.loadURL(url.href);
      return { ok: true };
    } catch {
      if (!view.webContents.isDestroyed() && tab.view === view && this.tabs.includes(tab)) {
        tab.state = { ...tab.state, loading: false, error: "load_failed" };
        this.publish();
      }
      return { ok: false, error: "unavailable" };
    }
  }

  private getSession(): Session {
    if (!this.browserSession) {
      const browserSession = session.fromPartition(BROWSER_PARTITION);
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on("will-download", (_event, item) => item.cancel());
      this.browserSession = browserSession;
    }
    return this.browserSession;
  }

  private async restoreSession(): Promise<void> {
    const browserSession = this.getSession();
    try {
      const snapshot = await this.sessionPersistence.restore(browserSession);
      if (snapshot?.tabs.length) {
        this.tabs = snapshot.tabs.map(({ id, url, examConversationId }) => {
          const page = parseLearnExamPageRequest(url);
          const isExam = page?.kind === "document" && !!examConversationId;
          return {
            id,
            kind: isExam ? "exam" as const : "web" as const,
            lastActivationOrder: 0,
            ...(isExam ? { examConversationId } : {}),
            view: null,
            state: {
              id,
              kind: isExam ? "exam" as const : "web" as const,
              url: isExam ? url : (parseHttpUrl(url)?.href ?? ""),
              title: "",
              loading: false,
              canGoBack: false,
              canGoForward: false,
              crashed: false,
            },
          };
        });
        this.activeTabId = snapshot.activeTabId || this.tabs[0].id;
        const activeTab = this.getActiveTab();
        if (activeTab) activeTab.lastActivationOrder = ++this.activationSequence;
      }
    } catch {
      // 恢复失败时保留默认空标签页，不影响应用启动。
    }
    if (this.disposed) return;
    this.initialized = true;
    browserSession.cookies.on("changed", this.onCookieChanged);
    const activeTab = this.getActiveTab();
    if (this.bounds && activeTab?.state.url) {
      try {
        this.ensureView(activeTab);
      } catch {
        activeTab.state = { ...activeTab.state, loading: false, error: "unavailable" };
      }
    }
    this.applyBounds();
    this.publish();
  }

  private readonly onCookieChanged = (): void => {
    this.schedulePersistence();
  };

  private schedulePersistence(): void {
    if (!this.initialized || this.disposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistSession().catch((error) => {
        console.warn("[BrowserPanel] 浏览器会话保存失败", error);
      });
    }, 800);
  }

  private persistSession(): Promise<void> {
    const operation = this.persistQueue.catch(() => undefined).then(async () => {
      await this.readyPromise;
      if (this.disposed) return;
      await this.sessionPersistence.save(this.getSession(), {
        activeTabId: this.activeTabId,
        tabs: this.tabs.map((tab) => ({
          id: tab.id,
          url: tab.state.url,
          ...(tab.kind === "exam" && tab.examConversationId ? { examConversationId: tab.examConversationId } : {}),
        })),
      });
    });
    this.persistQueue = operation;
    return operation;
  }

  private ensureView(tab: BrowserTab, restore = true): WebContentsView | null {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    if (tab.view && !tab.view.webContents.isDestroyed() && this.parentWindow === win) return tab.view;
    if (tab.view) this.destroyTabView(tab);
    if (this.parentWindow && this.parentWindow !== win) {
      this.destroyViews();
    } else {
      this.releaseOldestViewsUntilRoom(tab.id);
    }
    this.parentWindow = win;
    const isExam = tab.kind === "exam";
    const view = new WebContentsView({
      webPreferences: {
        session: isExam ? getLearnExamPageSession() : this.getSession(),
        ...(isExam ? { preload: path.join(app.getAppPath(), "dist", "preload", "preload", "learn-exam-page.js") } : {}),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    tab.view = view;
    if (isExam) {
      const page = parseLearnExamPageRequest(tab.state.url);
      if (page?.kind === "document" && tab.examConversationId) {
        tab.unregisterExamPage = registerExamPageSource(view.webContents, page.examId, tab.examConversationId);
      }
    }
    tab.state = {
      ...tab.state,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: undefined,
    };
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.attachEvents(tab, view);
    if (!this.observedWindows.has(win)) {
      this.observedWindows.add(win);
      win.once("closed", () => {
        if (this.parentWindow === win) {
          this.destroyViews();
          this.parentWindow = null;
        }
      });
    }
    if (restore && tab.state.url) {
      void view.webContents.loadURL(tab.state.url).catch(() => {
        if (!view.webContents.isDestroyed() && tab.view === view && this.tabs.includes(tab)) {
          tab.state = { ...tab.state, loading: false, error: "load_failed" };
          this.publish();
        }
      });
    }
    return view;
  }

  private attachEvents(tab: BrowserTab, view: WebContentsView): void {
    const contents = view.webContents;
    allowInternalNavigation(contents);
    const isLive = () => this.tabs.includes(tab) && tab.view === view && !contents.isDestroyed();
    const update = () => {
      if (!isLive()) return;
      tab.state = {
        ...tab.state,
        url: contents.getURL(),
        title: contents.getTitle(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      };
      this.publish();
    };
    contents.on("did-start-loading", () => {
      if (!isLive()) return;
      if (this.elementPickerTabId === tab.id) this.cancelElementPicker();
      this.forgetTabObservations(tab.id);
      this.onPlaywrightSnapshotNavigation(contents);
      tab.state = { ...tab.state, loading: true, error: undefined, crashed: false, favicon: undefined };
      this.publish();
    });
    contents.on("did-stop-loading", () => {
      if (!isLive()) return;
      tab.state = { ...tab.state, loading: false };
      update();
    });
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", () => {
      if (!isLive()) return;
      this.forgetTabObservations(tab.id);
      update();
    });
    contents.on("page-title-updated", (_event, title) => {
      if (!isLive()) return;
      tab.state = { ...tab.state, title };
      this.publish();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      if (!isLive()) return;
      const safeFavicons = favicons.flatMap((favicon) => {
        const normalized = normalizeFaviconUrl(favicon, contents.getURL());
        return normalized ? [normalized] : [];
      });
      tab.state = { ...tab.state, favicon: safeFavicons[0] };
      this.publish();
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (!isLive() || errorCode === -3 || !isMainFrame) return;
      tab.state = { ...tab.state, loading: false, error: "load_failed" };
      this.publish();
    });
    contents.on("render-process-gone", () => {
      this.onPlaywrightSnapshotNavigation(contents);
      if (!this.tabs.includes(tab)) return;
      tab.state = { ...tab.state, loading: false, crashed: true, error: "renderer_crashed" };
      this.publish();
    });
    contents.on("will-navigate", (event, targetUrl) => {
      const allowed = tab.kind === "exam"
        ? targetUrl === tab.state.url && parseLearnExamPageRequest(targetUrl)?.kind === "document"
        : !!parseHttpUrl(targetUrl);
      if (!allowed) event.preventDefault();
    });
    contents.on("will-redirect", (event, targetUrl) => {
      if (tab.kind === "exam" || !parseHttpUrl(targetUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (parseHttpUrl(url)) this.openNewTab(url, disposition !== "background-tab");
      return { action: "deny" };
    });
    contents.on("context-menu", (_event, params) => {
      if (!params.linkURL || !parseHttpUrl(params.linkURL) || !this.parentWindow || this.parentWindow.isDestroyed()) return;
      const locale = getLocaleContext().uiLocale.toLowerCase();
      const label = locale.startsWith("zh") ? "在新标签页打开" : locale.startsWith("ja") ? "新しいタブで開く" : "Open link in new tab";
      Menu.buildFromTemplate([{
        label,
        click: () => this.openNewTab(params.linkURL, true),
      }]).popup({ window: this.parentWindow });
    });
    contents.on("destroyed", () => {
      if (tab.view === view) tab.view = null;
    });
  }

  private openNewTab(url: string, activate: boolean): void {
    const parsed = parseHttpUrl(url);
    if (!parsed || this.disposed) return;
    const tab = this.createTab(activate);
    if (!activate) {
      // Background tabs should not create a page process until first selected.
      tab.state = { ...tab.state, url: parsed.href };
      this.publish();
      return;
    }
    this.applyBounds();
    this.publish();
    void this.navigateTab(tab, parsed.href);
  }

  private applyBounds(): void {
    const win = this.parentWindow;
    const bounds = this.bounds;
    if (!win || win.isDestroyed()) return;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      for (const tab of this.tabs) tab.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const [windowWidth, windowHeight] = win.getContentSize();
    const x = Math.max(0, Math.min(windowWidth, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(windowHeight, Math.round(bounds.y)));
    const width = Math.max(0, Math.min(windowWidth - x, Math.round(bounds.width)));
    const height = Math.max(0, Math.min(windowHeight - y, Math.round(bounds.height)));
    for (const tab of this.tabs) {
      const viewBounds = tab.id === this.activeTabId ? { x, y, width, height } : { x: 0, y: 0, width: 0, height: 0 };
      tab.view?.setBounds(viewBounds);
    }
  }

  private releaseOldestViewsUntilRoom(exceptTabId: string): void {
    const residentTabs = this.tabs
      .filter((tab) => tab.id !== exceptTabId && tab.view !== null)
      .sort((left, right) => left.lastActivationOrder - right.lastActivationOrder);
    while (residentTabs.length >= MAX_LIVE_TAB_VIEWS) {
      const oldest = residentTabs.shift();
      if (oldest) this.discardTabView(oldest);
    }
  }

  private discardTabView(tab: BrowserTab): void {
    this.destroyTabView(tab);
    tab.state = {
      ...tab.state,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: undefined,
    };
  }

  private destroyTabView(tab: BrowserTab): void {
    const view = tab.view;
    const win = this.parentWindow;
    tab.view = null;
    tab.unregisterExamPage?.();
    tab.unregisterExamPage = undefined;
    if (!view) return;
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    } catch { /* 主窗口关闭时原生视图可能已被 Electron 移除 */ }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* 忽略退出阶段的重复销毁 */ }
  }

  private destroyViews(): void {
    for (const tab of this.tabs) this.destroyTabView(tab);
  }

  private publish(): void {
    this.onStateChanged(this.getState());
    this.schedulePersistence();
  }
}
