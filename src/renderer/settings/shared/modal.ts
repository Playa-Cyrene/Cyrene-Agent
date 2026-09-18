// 设置页统一反馈与弹窗实现（语义化 + 兼容入口）。
// - showNotice：非阻塞轻提示（最多 3 条、自动关闭、重复消息合并）
// - showAlert / showConfirm：语义化阻塞弹窗（先进先出队列、焦点管理、危险态安全默认）
// - showHtmlModal / showInputModal：富文本/输入弹窗，与语义弹窗共用同一条阻塞队列
//   （同一窗口任意时刻只有一个阻塞弹窗；窗口卸载时 input 返回 null、confirm 返回 false）
// - showModal：旧签名的语义化兼容入口
// Electron 禁用了 window.alert / confirm / prompt，渲染层全部自绘实现。

import {
  FEEDBACK_NOTICE_DURATION_MS,
  FEEDBACK_NOTICE_MAX_COUNT,
  type AlertOptions,
  type ConfirmOptions,
  type FeedbackTone,
  type NoticeOptions,
} from "../../shared/feedback-types";
import { activateDialogFocus } from "./dialog-focus";
import { modalState, type BlockingDialogRequest, type HtmlModalOptions, type InputModalOptions } from "./modal-state";

/** 语义色调 → 统一线性 SVG 图标（描边颜色由 CSS 控制，不使用 emoji） */
const TONE_ICONS: Record<FeedbackTone, string> = {
  success: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>',
  info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5h.01"/></svg>',
  warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2L10 3Z"/><path d="M10 8v4M10 14.5h.01"/></svg>',
  error: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m7.5 7.5 5 5M12.5 7.5l-5 5"/></svg>',
};

/* ==================== 轻提示 ==================== */

/** 每条轻提示的自动关闭计时器（重复消息合并时用于重置） */
const noticeTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function ensureNoticeContainer(): HTMLElement {
  if (modalState.noticeContainer?.isConnected) return modalState.noticeContainer;
  const container = document.createElement("div");
  container.className = "cy-notice-stack";
  document.body.appendChild(container);
  modalState.noticeContainer = container;
  return container;
}

/** 非阻塞轻提示：最多同时 3 条、自动关闭、重复消息合并 */
export function showNotice(options: NoticeOptions): void {
  const container = ensureNoticeContainer();
  const durationMs = options.durationMs ?? FEEDBACK_NOTICE_DURATION_MS;
  const key = `${options.tone}:${options.message}`;
  const existing = [...container.children].find(
    (child) => (child as HTMLElement).dataset.noticeKey === key,
  ) as HTMLElement | undefined;
  if (existing) {
    // 重复消息合并：重置自动关闭计时并视为最新
    const previous = noticeTimers.get(existing);
    if (previous !== undefined) clearTimeout(previous);
    noticeTimers.set(existing, setTimeout(() => existing.remove(), durationMs));
    container.append(existing);
    options.focusTarget?.focus();
    return;
  }
  options.focusTarget?.focus();
  // 最多同时显示 3 条：堆满后不再新增，避免错误循环刷屏
  if (container.children.length >= FEEDBACK_NOTICE_MAX_COUNT) return;
  const item = document.createElement("div");
  item.className = `cy-notice cy-notice--${options.tone}`;
  item.dataset.noticeKey = key;
  item.setAttribute("role", options.tone === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "cy-notice__icon";
  icon.innerHTML = TONE_ICONS[options.tone];
  const message = document.createElement("span");
  message.className = "cy-notice__message";
  message.textContent = options.message;
  item.append(icon, message);
  container.append(item);
  noticeTimers.set(item, setTimeout(() => item.remove(), durationMs));
}

/* ==================== 阻塞弹窗（单实例 + 先进先出队列，四类共用） ==================== */

/** 当前展示中的弹窗的取消收尾入口（窗口卸载时按各弹窗语义安全解析） */
let activeCancel: (() => void) | null = null;
let unloadGuarded = false;
/** 卸载收尾进行中：抑制队列泵，避免收尾时又打开下一条弹窗导致其 Promise 悬挂 */
let unloading = false;

/** 按弹窗类型给出安全默认结果：confirm→false、input→null、alert/html→结束 */
function cancelRequest(request: BlockingDialogRequest): void {
  switch (request.kind) {
    case "confirm":
      request.resolve(false);
      break;
    case "input":
      request.resolve(null);
      break;
    default:
      request.resolve();
      break;
  }
}

function guardWindowUnload(): void {
  if (unloadGuarded) return;
  unloadGuarded = true;
  window.addEventListener("beforeunload", () => {
    // 窗口关闭时安全收尾：展示中的弹窗按取消解析，排队请求按安全默认值解析。
    // 收尾期间抑制队列泵（否则 activeCancel 收尾会立即打开下一条弹窗，其 Promise 反而悬挂）。
    unloading = true;
    try {
      activeCancel?.();
      while (modalState.blockingQueue.length > 0) {
        const request = modalState.blockingQueue.shift();
        if (!request) break;
        cancelRequest(request);
      }
    } finally {
      // beforeunload 可被用户取消：队列已全部按安全值解析，恢复泵以支持后续新弹窗
      unloading = false;
    }
  });
}

function pumpBlockingQueue(): void {
  if (unloading || modalState.blockingActive) return;
  const next = modalState.blockingQueue.shift();
  if (!next) return;
  modalState.blockingActive = true;
  try {
    renderBlockingDialog(next);
  } catch (error) {
    // 展示失败时记录错误并安全取消，绝不让危险操作默认执行
    console.error("[settings-feedback] 阻塞弹窗渲染失败", error);
    modalState.blockingActive = false;
    cancelRequest(next);
    pumpBlockingQueue();
  }
}

function enqueueBlockingDialog(request: BlockingDialogRequest): void {
  guardWindowUnload();
  modalState.blockingQueue.push(request);
  pumpBlockingQueue();
}

/** 队列驱动分发：语义弹窗 / 富文本弹窗 / 输入弹窗 */
function renderBlockingDialog(request: BlockingDialogRequest): void {
  switch (request.kind) {
    case "html":
      renderHtmlDialog(request);
      break;
    case "input":
      renderInputDialog(request);
      break;
    default:
      renderSemanticDialog(request);
      break;
  }
}

/** 队列收尾的公共部分：清理激活标记、解析请求并驱动下一条 */
function finishBlockingDialog(
  request: BlockingDialogRequest,
  resolve: () => void,
): void {
  activeCancel = null;
  modalState.blockingActive = false;
  resolve();
  pumpBlockingQueue();
}

function renderSemanticDialog(
  request: Extract<BlockingDialogRequest, { kind: "alert" | "confirm" }>,
): void {
  _initModalOverlay();
  const overlay = modalState.cyOverlay;
  if (!overlay) {
    // 初始化失败时记录错误并安全取消
    console.error("[settings-feedback] 无法创建阻塞弹窗容器");
    finishBlockingDialog(request, () => cancelRequest(request));
    return;
  }
  const dialog = overlay.querySelector(".cy-modal") as HTMLElement;
  const iconEl = overlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = overlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = overlay.querySelector("#cy-modal-message") as HTMLElement;
  const detailsWrap = overlay.querySelector("#cy-modal-details-wrap") as HTMLDetailsElement;
  const detailsEl = overlay.querySelector("#cy-modal-details") as HTMLElement;
  const actionsEl = overlay.querySelector("#cy-modal-actions") as HTMLElement;
  const confirmBtn = overlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;

  const options = request.options;
  const dangerous = request.kind === "confirm" && options.dangerous === true;
  const tone: FeedbackTone =
    request.kind === "alert"
      ? options.tone
      : (options.tone ?? (dangerous ? "error" : "warning"));

  // 语义图标与色调 class；用户文本一律 textContent，防止注入
  iconEl.className = `cy-modal__icon cy-modal__icon--${tone}`;
  iconEl.innerHTML = TONE_ICONS[tone];
  dialog.className = `cy-modal cy-modal--${tone}${dangerous ? " cy-modal--danger" : ""}`;
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  if (request.kind === "alert" && options.details) {
    detailsWrap.hidden = false;
    detailsEl.textContent = options.details;
  } else {
    detailsWrap.hidden = true;
    detailsEl.textContent = "";
  }

  // alert 只有单个动作按钮；confirm 保证取消按钮在场且位于确认按钮左侧
  let cancelBtn = overlay.querySelector("#cy-modal-cancel") as HTMLButtonElement | null;
  if (request.kind === "confirm" && !cancelBtn) {
    cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.id = "cy-modal-cancel";
    cancelBtn.className = "ghost-btn";
    actionsEl.insertBefore(cancelBtn, confirmBtn);
  }
  if (request.kind === "alert") {
    cancelBtn?.remove();
    confirmBtn.textContent = options.confirmText ?? "知道了";
  } else {
    cancelBtn!.textContent = options.cancelText ?? "取消";
    confirmBtn.textContent = options.confirmText ?? "确定";
  }
  confirmBtn.className = `btn-primary${dangerous ? " btn-danger" : ""}`;
  overlay.classList.remove("is-hidden");

  let settled = false;
  let releaseFocus: (() => void) | null = null;
  const settle = (result: boolean) => {
    if (settled) return;
    settled = true;
    releaseFocus?.();
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn?.removeEventListener("click", onCancel);
    overlay.classList.add("is-hidden");
    // alert 的 resolve 无参（传入的布尔值只属于 confirm 语义）
    finishBlockingDialog(request, () => {
      if (request.kind === "confirm") request.resolve(result);
      else request.resolve();
    });
  };
  const onCancel = () => settle(false);
  const onConfirm = () => settle(request.kind === "confirm");
  activeCancel = onCancel;
  confirmBtn.addEventListener("click", onConfirm);
  cancelBtn?.addEventListener("click", onCancel);
  // 危险确认默认聚焦取消按钮；其余聚焦确认按钮。Esc 等同取消，Tab 循环，关闭后焦点恢复
  releaseFocus = activateDialogFocus(dialog, dangerous ? cancelBtn! : confirmBtn, onCancel);
}

/** 单按钮错误/信息弹窗：长原因或包含下一步的失败 */
export function showAlert(options: AlertOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueueBlockingDialog({ kind: "alert", options, resolve });
  });
}

/** 双按钮确认弹窗：删除、覆盖、清空等危险操作传 dangerous */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  const tone = options.tone ?? (options.dangerous ? "error" : "warning");
  return new Promise<boolean>((resolve) => {
    enqueueBlockingDialog({ kind: "confirm", options: { ...options, tone }, resolve });
  });
}

/* ==================== 语义弹窗容器 ==================== */

export function _initModalOverlay(): void {
  if (modalState.cyOverlay) return;
  modalState.cyOverlay = document.createElement("div");
  modalState.cyOverlay.id = "cy-modal-overlay";
  modalState.cyOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyOverlay.innerHTML = [
    '<div class="cy-modal" role="alertdialog" aria-modal="true" aria-labelledby="cy-modal-title" aria-describedby="cy-modal-message">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon cy-modal__icon--warning" id="cy-modal-icon" aria-hidden="true"></span>',
    '    <h3 class="cy-modal__title" id="cy-modal-title">提示</h3>',
    '  </div>',
    '  <p class="cy-modal__body" id="cy-modal-message"></p>',
    '  <details class="cy-modal__details-wrap" id="cy-modal-details-wrap" hidden>',
    '    <summary>查看详情</summary>',
    '    <pre class="cy-modal__details" id="cy-modal-details"></pre>',
    '  </details>',
    '  <div class="cy-modal__actions" id="cy-modal-actions">',
    '    <button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-modal-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyOverlay);
}

/**
 * 兼容入口：旧签名 showModal 的语义化包装。
 * 仅供尚未纳入迁移范围的内部页面使用，不接受新的调用。
 */
export function showModal(options: {
  title: string;
  message: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return showConfirm({
    title: options.title,
    message: options.message,
    confirmText: options.confirmText,
    cancelText: options.cancelText,
  });
}

/* ==================== 富文本模态框（阻塞队列成员） ==================== */

function _initHtmlModalOverlay(): void {
  if (modalState.cyHtmlOverlay) return;
  modalState.cyHtmlOverlay = document.createElement("div");
  modalState.cyHtmlOverlay.id = "cy-html-modal-overlay";
  modalState.cyHtmlOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyHtmlOverlay.innerHTML = [
    '<div class="cy-modal cy-html-modal" role="dialog" aria-modal="true">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-html-modal-icon">📌</span>',
    '    <h3 class="cy-modal__title" id="cy-html-modal-title">说明</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <div class="cy-html-modal__body" id="cy-html-modal-body"></div>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="btn-primary" id="cy-html-modal-confirm">知道了</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyHtmlOverlay);
}

/**
 * 富文本模态框：展示多组说明（规格 / 费用 / 过期规则等）。
 * 与语义弹窗共用阻塞队列，展示期间其他阻塞弹窗只能排队等待。
 * 调用方负责传入安全的 HTML（项目内固定字符串）；若内容来自用户/网络必须先 escapeHtml。
 */
export function showHtmlModal(options: HtmlModalOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueueBlockingDialog({ kind: "html", options, resolve });
  });
}

function renderHtmlDialog(
  request: Extract<BlockingDialogRequest, { kind: "html" }>,
): void {
  _initHtmlModalOverlay();
  const overlay = modalState.cyHtmlOverlay;
  if (!overlay) {
    console.error("[settings-feedback] 无法创建富文本弹窗容器");
    finishBlockingDialog(request, () => request.resolve());
    return;
  }
  const options = request.options;
  const iconEl = overlay.querySelector("#cy-html-modal-icon") as HTMLElement;
  const titleEl = overlay.querySelector("#cy-html-modal-title") as HTMLElement;
  const bodyEl = overlay.querySelector("#cy-html-modal-body") as HTMLElement;
  const confirmBtn = overlay.querySelector("#cy-html-modal-confirm") as HTMLButtonElement;
  const dialog = overlay.querySelector(".cy-modal") as HTMLElement;
  iconEl.innerHTML = options.icon || "📌";
  titleEl.textContent = options.title;
  bodyEl.innerHTML = options.htmlBody;
  confirmBtn.textContent = options.confirmText || "知道了";
  overlay.classList.remove("is-hidden");

  let settled = false;
  let releaseFocus: (() => void) | null = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    releaseFocus?.();
    confirmBtn.removeEventListener("click", settle);
    overlay.classList.add("is-hidden");
    finishBlockingDialog(request, () => request.resolve());
  };
  activeCancel = settle;
  confirmBtn.addEventListener("click", settle);
  releaseFocus = activateDialogFocus(dialog, confirmBtn, settle);
}

/* ==================== 输入模态框（阻塞队列成员） ==================== */

// 输入弹窗默认的铅笔线性图标
const INPUT_ICON_SVG =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Inline input modal (Electron 禁用了 window.prompt，所以自己实现)
function _initInputOverlay(): void {
  if (modalState.cyInputOverlay) return;
  modalState.cyInputOverlay = document.createElement("div");
  modalState.cyInputOverlay.id = "cy-input-overlay";
  modalState.cyInputOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyInputOverlay.innerHTML = [
    '<div class="cy-modal" role="dialog" aria-modal="true" style="width:min(420px,90vw);">',
    '  <div class="cy-modal__head">',
    `    <span class="cy-modal__icon" id="cy-input-icon">${INPUT_ICON_SVG}</span>`,
    '    <h3 class="cy-modal__title" id="cy-input-title">请输入</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-input-message"></p>',
    '  <input type="text" id="cy-input-field" autocomplete="off" spellcheck="false" />',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-input-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-input-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyInputOverlay);
}

/**
 * 输入模态框：进入统一阻塞队列，展示期间其他阻塞弹窗排队等待；
 * 窗口卸载时按取消收尾（resolve null）。连续调用不会在同一输入框上叠加监听器。
 */
export function showInputModal(options: InputModalOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueueBlockingDialog({ kind: "input", options, resolve });
  });
}

function renderInputDialog(
  request: Extract<BlockingDialogRequest, { kind: "input" }>,
): void {
  _initInputOverlay();
  const overlay = modalState.cyInputOverlay;
  if (!overlay) {
    console.error("[settings-feedback] 无法创建输入弹窗容器");
    finishBlockingDialog(request, () => request.resolve(null));
    return;
  }
  const options = request.options;
  const iconEl = overlay.querySelector("#cy-input-icon") as HTMLElement;
  const titleEl = overlay.querySelector("#cy-input-title") as HTMLElement;
  const msgEl = overlay.querySelector("#cy-input-message") as HTMLElement;
  const inputEl = overlay.querySelector("#cy-input-field") as HTMLInputElement;
  const cancelBtn = overlay.querySelector("#cy-input-cancel") as HTMLButtonElement;
  const confirmBtn = overlay.querySelector("#cy-input-confirm") as HTMLButtonElement;
  const dialog = overlay.querySelector(".cy-modal") as HTMLElement;
  // 图标只接受内联 SVG；emoji 一律回退到统一线性图标
  if (options.icon && options.icon.startsWith("<svg")) iconEl.innerHTML = options.icon;
  else iconEl.innerHTML = INPUT_ICON_SVG;
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  inputEl.value = options.defaultValue || "";
  inputEl.placeholder = options.placeholder || "";
  cancelBtn.textContent = options.cancelText || "取消";
  confirmBtn.textContent = options.confirmText || "确定";
  overlay.classList.remove("is-hidden");

  let settled = false;
  let releaseFocus: (() => void) | null = null;
  const settle = (result: string | null) => {
    if (settled) return;
    settled = true;
    releaseFocus?.();
    cancelBtn.removeEventListener("click", onCancel);
    confirmBtn.removeEventListener("click", onConfirm);
    inputEl.removeEventListener("keydown", onKey);
    overlay.classList.add("is-hidden");
    finishBlockingDialog(request, () => request.resolve(result));
  };
  const onCancel = () => settle(null);
  const onConfirm = () => settle(inputEl.value);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
  };
  activeCancel = onCancel;
  cancelBtn.addEventListener("click", onCancel);
  confirmBtn.addEventListener("click", onConfirm);
  inputEl.addEventListener("keydown", onKey);
  // 输入框立即聚焦；Esc 取消、Tab 循环、关闭后焦点恢复
  releaseFocus = activateDialogFocus(dialog, inputEl, onCancel);
}
