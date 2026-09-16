# Renderer Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 A「轻盈品牌化」反馈系统替换渲染层全部浏览器默认提示与确认框，同时保留真正的系统文件选择器和启动致命错误框。

**Architecture:** 设置页在现有 DOM（文档对象模型）弹窗上增加语义化阻塞弹窗、轻提示和焦点管理；React（界面框架）页面通过 Provider（上下文提供器）封装现有 Ant Design（蚂蚁设计体系）的 Modal（模态框）与 message（消息提示）。两端共享类型、默认值和主题变量，不共享运行时节点。

**Tech Stack:** TypeScript（类型脚本）、Vitest（测试框架）、JSDOM（浏览器环境模拟器）、React、Ant Design、CSS（层叠样式表）、Electron（桌面应用框架）

**Spec:** `docs/superpowers/specs/2026-09-16-renderer-feedback-design.md`

## Global Constraints

- 不新增第三方依赖；设置页复用现有 `src/renderer/settings/shared/modal.ts`，React 页面复用已安装的 Ant Design 6.5.2。
- 采用 A「轻盈品牌化」视觉：珍珠白、微粉强调、18 像素圆角、克制阴影、统一 SVG（可缩放矢量图形）图标。
- 成功、普通信息、字段校验和简短失败使用非阻塞轻提示；默认持续 3000 毫秒，同一窗口最多 3 条，短时间重复消息合并。
- 长错误或包含下一步操作的错误使用单按钮弹窗；删除、覆盖、清空使用双按钮危险确认弹窗。
- 危险确认默认聚焦取消按钮；遮罩不关闭；`Esc` 取消；弹窗关闭后焦点返回触发元素。
- 技术详情只作为纯文本折叠内容展示，不允许直接注入 HTML（超文本标记语言）。
- 不修改 Electron 文件/文件夹选择器、应用启动阶段的致命错误框及其 IPC（进程间通信）协议。
- 当前工作区包含大量无关修改。每次提交前必须运行 `git diff --cached --name-only` 和 `git diff --cached`；对已有修改的文件使用 `git add -p -- <paths>`，只暂存本任务片段。
- 每个行为改动遵循 TDD（测试驱动开发）：先观察目标测试失败，再写最小实现，再观察通过。

---

### Task 1: Define the shared feedback contract

**Files:**
- Create: `src/renderer/shared/feedback-types.ts`
- Create: `src/renderer/shared/feedback-types.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `FeedbackTone`、`NoticeOptions`、`AlertOptions`、`ConfirmOptions`、`FeedbackApi`、`FEEDBACK_NOTICE_DURATION_MS`、`FEEDBACK_NOTICE_MAX_COUNT`。

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_NOTICE_DURATION_MS,
  FEEDBACK_NOTICE_MAX_COUNT,
  type FeedbackApi,
} from "./feedback-types";

describe("renderer feedback contract", () => {
  it("uses the approved notice defaults", () => {
    expect(FEEDBACK_NOTICE_DURATION_MS).toBe(3000);
    expect(FEEDBACK_NOTICE_MAX_COUNT).toBe(3);
  });

  it("keeps confirm and alert results asynchronous", () => {
    const api = null as unknown as FeedbackApi;
    expectTypeOf(api.confirm).returns.toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(api.alert).returns.toEqualTypeOf<Promise<void>>();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm test -- src/renderer/shared/feedback-types.test.ts`

Expected: FAIL because `./feedback-types` does not exist.

- [ ] **Step 3: Implement the exact shared contract**

```ts
export const FEEDBACK_NOTICE_DURATION_MS = 3000;
export const FEEDBACK_NOTICE_MAX_COUNT = 3;

export type FeedbackTone = "success" | "info" | "warning" | "error";

export interface NoticeOptions {
  tone: FeedbackTone;
  message: string;
  durationMs?: number;
  focusTarget?: { focus: () => void } | null;
}

export interface AlertOptions {
  tone: FeedbackTone;
  title: string;
  message: string;
  details?: string;
  confirmText?: string;
}

export interface ConfirmOptions {
  tone?: Exclude<FeedbackTone, "success">;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  dangerous?: boolean;
}

export interface FeedbackApi {
  notice: (options: NoticeOptions) => void;
  alert: (options: AlertOptions) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}
```

- [ ] **Step 4: Run the contract test**

Run: `npm test -- src/renderer/shared/feedback-types.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit only the new contract files**

```powershell
git add -- src/renderer/shared/feedback-types.ts src/renderer/shared/feedback-types.test.ts
git diff --cached --check
git commit -m "feat(ui): define renderer feedback contract"
```

---

### Task 2: Add reusable focus management for settings dialogs

**Files:**
- Create: `src/renderer/settings/shared/dialog-focus.ts`
- Create: `src/renderer/settings/shared/dialog-focus.test.ts`

**Interfaces:**
- Consumes: 一个弹窗根元素、初始焦点元素和 `onEscape` 回调。
- Produces: `activateDialogFocus(dialog, initialFocus, onEscape): () => void`，返回清理函数。

- [ ] **Step 1: Write failing keyboard and focus tests**

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateDialogFocus } from "./dialog-focus";

describe("activateDialogFocus", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="trigger">打开</button><div id="dialog"><button id="cancel">取消</button><button id="ok">确定</button></div>';
  });

  it("focuses the safe action and restores the trigger", () => {
    const trigger = document.getElementById("trigger") as HTMLButtonElement;
    const dialog = document.getElementById("dialog") as HTMLElement;
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    trigger.focus();
    const cleanup = activateDialogFocus(dialog, cancel, vi.fn());
    expect(document.activeElement).toBe(cancel);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab and maps Escape to cancellation", () => {
    const dialog = document.getElementById("dialog") as HTMLElement;
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    const ok = document.getElementById("ok") as HTMLButtonElement;
    const onEscape = vi.fn();
    const cleanup = activateDialogFocus(dialog, cancel, onEscape);
    ok.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
```

- [ ] **Step 2: Run the focus tests and observe the missing module failure**

Run: `npm test -- src/renderer/settings/shared/dialog-focus.test.ts`

Expected: FAIL because `activateDialogFocus` is not implemented.

- [ ] **Step 3: Implement focus trapping and restoration**

```ts
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function activateDialogFocus(
  dialog: HTMLElement,
  initialFocus: HTMLElement,
  onEscape: () => void,
): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };
  dialog.addEventListener("keydown", onKeyDown);
  initialFocus.focus();
  return () => {
    dialog.removeEventListener("keydown", onKeyDown);
    previous?.focus();
  };
}
```

- [ ] **Step 4: Run the focus tests**

Run: `npm test -- src/renderer/settings/shared/dialog-focus.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit the focus helper**

```powershell
git add -- src/renderer/settings/shared/dialog-focus.ts src/renderer/settings/shared/dialog-focus.test.ts
git diff --cached --check
git commit -m "feat(settings): add accessible dialog focus management"
```

---

### Task 3: Upgrade settings blocking dialogs and notice stack

**Files:**
- Modify: `src/renderer/settings/shared/modal-state.ts`
- Modify: `src/renderer/settings/shared/modal.ts`
- Create: `src/renderer/settings/shared/modal.test.ts`
- Modify: `src/renderer/settings/mcp/modal-interaction.test.ts`

**Interfaces:**
- Consumes: Task 1 feedback types and Task 2 `activateDialogFocus`.
- Produces: `showNotice(options): void`、`showAlert(options): Promise<void>`、`showConfirm(options): Promise<boolean>`；保留 `showModal`、`showHtmlModal`、`showInputModal` 兼容入口。

- [ ] **Step 1: Write failing behavior tests for semantic dialogs and notices**

Add focused tests with fake timers:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modalState } from "./modal-state";
import { showAlert, showConfirm, showNotice } from "./modal";

describe("settings feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="trigger">打开</button>';
    Object.assign(modalState, {
      cyOverlay: null,
      cyHtmlOverlay: null,
      cyInputOverlay: null,
      noticeContainer: null,
      blockingQueue: [],
      blockingActive: false,
    });
  });

  it("renders at most three notices and merges duplicate messages", () => {
    showNotice({ tone: "success", message: "设置已保存" });
    showNotice({ tone: "success", message: "设置已保存" });
    showNotice({ tone: "info", message: "第一条" });
    showNotice({ tone: "warning", message: "第二条" });
    showNotice({ tone: "error", message: "第三条" });
    expect(document.querySelectorAll(".cy-notice")).toHaveLength(3);
    expect(document.body.textContent?.match(/设置已保存/g)).toHaveLength(1);
  });

  it("auto closes a notice after the approved duration", () => {
    showNotice({ tone: "success", message: "设置已保存" });
    vi.advanceTimersByTime(3000);
    expect(document.querySelector(".cy-notice")).toBeNull();
  });

  it("shows alert details as text and only one action", async () => {
    const promise = showAlert({ tone: "error", title: "打开失败", message: "请查看详情", details: '<img src=x onerror="alert(1)">' });
    expect(document.querySelectorAll("#cy-modal-overlay button")).toHaveLength(1);
    expect(document.querySelector(".cy-modal__details")?.textContent).toContain("<img src=x");
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await expect(promise).resolves.toBeUndefined();
  });

  it("makes dangerous confirmation safe by default", async () => {
    const trigger = document.getElementById("trigger") as HTMLButtonElement;
    trigger.focus();
    const promise = showConfirm({ title: "删除任务？", message: "删除后无法恢复。", dangerous: true, confirmText: "删除任务" });
    expect(document.activeElement?.id).toBe("cy-modal-cancel");
    document.getElementById("cy-modal-overlay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("cy-modal-overlay")?.classList.contains("is-hidden")).toBe(false);
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await expect(promise).resolves.toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens blocking requests in first-in-first-out order", async () => {
    const first = showAlert({ tone: "info", title: "第一条", message: "先处理" });
    const second = showConfirm({ title: "第二条", message: "后处理" });
    expect(document.getElementById("cy-modal-title")?.textContent).toBe("第一条");
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await first;
    expect(document.getElementById("cy-modal-title")?.textContent).toBe("第二条");
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the modal tests and verify missing export/state failures**

Run: `npm test -- src/renderer/settings/shared/modal.test.ts src/renderer/settings/mcp/modal-interaction.test.ts`

Expected: FAIL because semantic exports and notice state do not exist.

- [ ] **Step 3: Implement a single blocking-dialog renderer plus notice stack**

Use one internal queue for `showAlert` and `showConfirm`, set all user-provided text through `textContent`, and map tones to fixed SVG strings:

```ts
const NOTICE_ICONS: Record<FeedbackTone, string> = {
  success: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>',
  info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5h.01"/></svg>',
  warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2L10 3Z"/><path d="M10 8v4M10 14.5h.01"/></svg>',
  error: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m7.5 7.5 5 5M12.5 7.5l-5 5"/></svg>',
};

export function showNotice(options: NoticeOptions): void {
  const durationMs = options.durationMs ?? FEEDBACK_NOTICE_DURATION_MS;
  const key = `${options.tone}:${options.message}`;
  const existing = [...(modalState.noticeContainer?.children ?? [])]
    .find((child) => (child as HTMLElement).dataset.noticeKey === key);
  if (existing) return;
  const item = document.createElement("div");
  item.className = `cy-notice cy-notice--${options.tone}`;
  item.dataset.noticeKey = key;
  item.setAttribute("role", options.tone === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "cy-notice__icon";
  icon.innerHTML = NOTICE_ICONS[options.tone];
  const message = document.createElement("span");
  message.className = "cy-notice__message";
  message.textContent = options.message;
  item.append(icon, message);
  modalState.noticeContainer!.append(item);
  while (modalState.noticeContainer!.children.length > FEEDBACK_NOTICE_MAX_COUNT) {
    modalState.noticeContainer!.firstElementChild?.remove();
  }
  options.focusTarget?.focus();
  window.setTimeout(() => item.remove(), durationMs);
}

export function showAlert(options: AlertOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueueBlockingDialog({ kind: "alert", options, resolve });
  });
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  const normalized = { tone: options.tone ?? (options.dangerous ? "error" : "warning"), ...options };
  return new Promise<boolean>((resolve) => {
    enqueueBlockingDialog({ kind: "confirm", options: normalized, resolve });
  });
}

interface LegacyModalOptions {
  title: string;
  message: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}

export function showModal(options: LegacyModalOptions): Promise<boolean> {
  return showConfirm({
    title: options.title,
    message: options.message,
    confirmText: options.confirmText,
    cancelText: options.cancelText,
  });
}
```

Define the queue state in `modal-state.ts` with an explicit discriminated union:

```ts
import type { AlertOptions, ConfirmOptions } from "../../shared/feedback-types";

export type BlockingDialogRequest =
  | { kind: "alert"; options: AlertOptions; resolve: () => void }
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void };

export const modalState = {
  cyOverlay: null as HTMLElement | null,
  cyHtmlOverlay: null as HTMLElement | null,
  cyInputOverlay: null as HTMLElement | null,
  noticeContainer: null as HTMLElement | null,
  blockingQueue: [] as BlockingDialogRequest[],
  blockingActive: false,
};
```

The implementation must also:

- give the dialog `aria-labelledby` and `aria-describedby`;
- hide the cancel button for alerts;
- add `btn-danger` only when `dangerous` is true;
- call `activateDialogFocus`, focusing cancel for dangerous confirmation and confirm otherwise;
- ignore backdrop clicks;
- resolve queued requests in first-in-first-out order;
- settle active and queued requests safely when the window unloads.

- [ ] **Step 4: Update existing MCP modal assertions and rerun tests**

Replace emoji assertions with tone/class assertions and keep existing HTML/input behavior checks.

Run: `npm test -- src/renderer/settings/shared/modal.test.ts src/renderer/settings/mcp/modal-interaction.test.ts`

Expected: PASS for both files.

- [ ] **Step 5: Commit only settings feedback engine hunks**

```powershell
git add -- src/renderer/settings/shared/modal-state.ts src/renderer/settings/shared/modal.ts src/renderer/settings/shared/modal.test.ts src/renderer/settings/mcp/modal-interaction.test.ts
git diff --cached --check
git commit -m "feat(settings): add semantic dialogs and notices"
```

---

### Task 4: Apply the A visual system to settings feedback

**Files:**
- Modify: `src/renderer/ui/theme.css`
- Modify: `src/renderer/settings/settings.css`
- Modify: `src/renderer/settings/shared/modal.ts`
- Create: `src/renderer/settings/shared/modal-style.test.ts`

**Interfaces:**
- Consumes: Task 3 semantic DOM classes.
- Produces: shared feedback tokens and complete A-style settings presentation.

- [ ] **Step 1: Write a failing style regression test**

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const theme = fs.readFileSync(fileURLToPath(new URL("../../ui/theme.css", import.meta.url)), "utf8");
const css = fs.readFileSync(fileURLToPath(new URL("../settings.css", import.meta.url)), "utf8");
const modal = fs.readFileSync(fileURLToPath(new URL("./modal.ts", import.meta.url)), "utf8");

describe("settings feedback visual contract", () => {
  it("defines shared feedback tokens and semantic states", () => {
    expect(theme).toContain("--rb-feedback-radius: 18px");
    expect(theme).toContain("--rb-feedback-danger:");
    expect(css).toContain(".cy-modal--danger");
    expect(css).toContain(".cy-notice--success");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("does not keep input presentation inline", () => {
    expect(modal).not.toMatch(/id="cy-input-field"[^>]+style=/);
  });
});
```

- [ ] **Step 2: Run the style test and verify it fails on missing tokens/classes**

Run: `npm test -- src/renderer/settings/shared/modal-style.test.ts`

Expected: FAIL on `--rb-feedback-radius` and semantic selectors.

- [ ] **Step 3: Add shared tokens and component styles**

Add dark-safe defaults under `:root`, then override surface, border, shadow, and text contrast under `[data-ui-theme="pearl-white"]`. Both scopes keep the same semantic variable names:

```css
:root {
  --rb-feedback-radius: 18px;
  --rb-feedback-surface: rgba(30, 25, 35, 0.97);
  --rb-feedback-border: rgba(255, 182, 220, 0.22);
  --rb-feedback-shadow: 0 28px 70px rgba(0, 0, 0, 0.38);
  --rb-feedback-danger: #e15b70;
  --rb-feedback-success: #43a877;
  --rb-feedback-warning: #d09a43;
  --rb-feedback-info: var(--rb-pink-400);
  --rb-feedback-motion: 180ms;
}

[data-ui-theme="pearl-white"] {
--rb-feedback-radius: 18px;
--rb-feedback-surface: rgba(255, 255, 255, 0.96);
--rb-feedback-border: rgba(220, 183, 207, 0.75);
--rb-feedback-shadow: 0 28px 70px rgba(67, 42, 59, 0.17);
--rb-feedback-danger: #d94f61;
--rb-feedback-success: #43a877;
--rb-feedback-warning: #c58a31;
--rb-feedback-info: var(--rb-pink-500);
--rb-feedback-motion: 180ms;
}
```

Update `settings.css` so `.cy-modal` uses a 380-pixel maximum width, 18-pixel radius, 22-pixel content padding, fixed icon tile, no divider, semantic danger button, and responsive width. Add `.cy-notice-stack` at the top-right with three-item stacking and pointer-safe spacing. Add reduced-motion overrides that set transition and animation duration to zero.

Move the input field's inline declarations to `#cy-input-field` rules and retain existing pearl-white overrides without `!important` where selector specificity is sufficient.

- [ ] **Step 4: Run visual contract and modal behavior tests**

Run: `npm test -- src/renderer/settings/shared/modal-style.test.ts src/renderer/settings/shared/modal.test.ts src/renderer/settings/mcp/modal-interaction.test.ts src/renderer/settings/settings-i18n-regression.test.ts`

Expected: PASS for all selected files.

- [ ] **Step 5: Commit the A visual system**

```powershell
git add -p -- src/renderer/ui/theme.css src/renderer/settings/settings.css src/renderer/settings/shared/modal.ts
git add -- src/renderer/settings/shared/modal-style.test.ts
git diff --cached --check
git commit -m "style(ui): apply branded renderer feedback visuals"
```

---

### Task 5: Migrate settings pages except TTS and RAG

**Files:**
- Modify: `src/renderer/settings/mcp/panel.ts`
- Modify: `src/renderer/settings/scheduler/panel.ts`
- Modify: `src/renderer/settings/tokens/panel.ts`
- Modify: `src/renderer/settings/settings.ts`
- Modify: `src/renderer/settings/channels/panel.ts`
- Modify: `src/renderer/settings/memory/panel.ts`
- Modify: `src/renderer/settings/preferences/panel.ts`
- Modify: `src/renderer/settings/mcp/panel.test.ts`
- Modify: `src/renderer/settings/mcp/modal-interaction.test.ts`
- Modify: `src/renderer/settings/tokens/cache-statistics.test.ts`
- Create: `src/renderer/settings/default-dialogs-regression.test.ts`

**Interfaces:**
- Consumes: Task 3 `showNotice`、`showAlert`、`showConfirm`。
- Produces: migrated non-TTS/RAG settings call sites with no default browser dialogs and no new `showModal` calls.

- [ ] **Step 1: Write the failing settings source regression test**

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsRoot = fileURLToPath(new URL(".", import.meta.url));
const files = [
  "mcp/panel.ts", "scheduler/panel.ts", "tokens/panel.ts", "settings.ts",
  "channels/panel.ts", "memory/panel.ts", "preferences/panel.ts",
];

describe("settings feedback migration", () => {
  it("contains no default dialogs or legacy showModal calls", () => {
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(settingsRoot, file), "utf8");
      return /\b(?:window\.)?(?:alert|confirm)\s*\(|\bshowModal\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the regression test and observe current offenders**

Run: `npm test -- src/renderer/settings/default-dialogs-regression.test.ts`

Expected: FAIL listing all seven files because each currently contains a default dialog call or a legacy `showModal` call.

- [ ] **Step 3: Migrate call sites by semantic category**

Use the following mapping, preserving business text:

```ts
// Field validation or short failure
showNotice({ tone: "warning", message: "请输入有效的启动命令" });
showNotice({ tone: "error", message: result.error ?? "切换失败" });

// Success
showNotice({ tone: "success", message: `“${name}”已连接，发现 ${count} 个工具。` });

// Long failure with technical detail
await showAlert({
  tone: "error",
  title: "表情包管理窗口打开失败",
  message: "请检查终端日志后重试。",
  details: result?.error,
});

// Dangerous action
const confirmed = await showConfirm({
  title: "删除导入知识？",
  message,
  confirmText: "删除",
  dangerous: true,
});
```

Required mappings:

- MCP invalid command → warning notice; add success → success notice; add failure/exception → error alert with details.
- Scheduler toggle/run/delete failures → error notice; plugin-created enable → warning confirm; deletion → dangerous confirm.
- Token reset, imported-knowledge delete, and channel-log clear → dangerous confirm.
- Memory save failure → error notice.
- Sticker-manager open failure → error alert with optional details.

- [ ] **Step 4: Update panel tests and run the migrated settings suite**

Run: `npm test -- src/renderer/settings/default-dialogs-regression.test.ts src/renderer/settings/mcp/panel.test.ts src/renderer/settings/mcp/modal-interaction.test.ts src/renderer/settings/scheduler src/renderer/settings/tokens src/renderer/settings/memory src/renderer/settings/preferences src/renderer/settings/channels`

Expected: PASS with no default-dialog offender.

- [ ] **Step 5: Commit only migration hunks**

```powershell
git add -p -- src/renderer/settings/mcp/panel.ts src/renderer/settings/scheduler/panel.ts src/renderer/settings/tokens/panel.ts src/renderer/settings/settings.ts src/renderer/settings/channels/panel.ts src/renderer/settings/memory/panel.ts src/renderer/settings/preferences/panel.ts
git add -p -- src/renderer/settings/mcp/panel.test.ts src/renderer/settings/mcp/modal-interaction.test.ts src/renderer/settings/tokens/cache-statistics.test.ts
git add -- src/renderer/settings/default-dialogs-regression.test.ts
git diff --cached --check
git commit -m "refactor(settings): replace default dialogs with feedback API"
```

---

### Task 6: Migrate TTS and remove the RAG duplicate modal

**Files:**
- Modify: `src/renderer/settings/tts/panel.ts`
- Modify: `src/renderer/settings/tts/panel.test.ts`
- Modify: `src/renderer/settings/rag/panel.ts`
- Create: `src/renderer/settings/rag/panel.test.ts`
- Modify: `src/renderer/settings/default-dialogs-regression.test.ts`

**Interfaces:**
- Consumes: Task 3 settings feedback API.
- Produces: TTS（文本转语音）与 RAG 页面无默认弹窗；RAG 不再维护私有 `_showModal`。

- [ ] **Step 1: Extend the failing settings scan to TTS and RAG**

Append `"tts/panel.ts"` and `"rag/panel.ts"` to the file list, and add:

```ts
it("does not duplicate the shared modal inside RAG", () => {
  const source = fs.readFileSync(path.join(settingsRoot, "rag/panel.ts"), "utf8");
  expect(source).not.toContain("function _showModal");
  expect(source).not.toContain('id = "cy-modal-overlay"');
});
```

- [ ] **Step 2: Run the scan and observe TTS/RAG failures**

Run: `npm test -- src/renderer/settings/default-dialogs-regression.test.ts`

Expected: FAIL listing both files and the duplicate RAG implementation.

- [ ] **Step 3: Convert all TTS and RAG feedback**

At the top of both panels, import the shared functions:

```ts
import { showAlert, showNotice } from "../shared/modal";
```

For every missing required text field, use a warning notice and pass the same element already read through `ttsEl(id)` as `focusTarget`. File-selection validations use a warning notice without moving focus because their text fields are read-only and the adjacent picker button is the actionable control. Every caught synthesis/test exception uses `showAlert` with a stable user-facing title and the exception string in `details`; existing inline status elements remain responsible for long-running progress.

For RAG:

```ts
showNotice({
  tone: "info",
  message: `已切换至 BGE-M3，并清除 ${result.clearedEntries} 条旧向量记忆。`,
});

await showAlert({
  tone: "error",
  title: "模型切换失败",
  message: "已恢复此前选择。",
  details: result?.error || "未知错误",
});
```

Delete the complete inline `_showModal` implementation and replace its existing callers with `showAlert` or `showConfirm` according to whether they require a choice.

- [ ] **Step 4: Run focused TTS/RAG and settings scan tests**

Run: `npm test -- src/renderer/settings/default-dialogs-regression.test.ts src/renderer/settings/tts/panel.test.ts src/renderer/settings/rag/panel.test.ts src/renderer/settings/shared/modal.test.ts`

Expected: PASS with no browser default or duplicate modal implementation.

- [ ] **Step 5: Commit TTS/RAG migration hunks**

```powershell
git add -p -- src/renderer/settings/tts/panel.ts src/renderer/settings/tts/panel.test.ts src/renderer/settings/rag/panel.ts src/renderer/settings/default-dialogs-regression.test.ts
git add -- src/renderer/settings/rag/panel.test.ts
git diff --cached --check
git commit -m "refactor(settings): unify TTS and RAG feedback"
```

---

### Task 7: Build the React feedback provider

**Files:**
- Create: `src/renderer/react/components/feedback/FeedbackProvider.tsx`
- Create: `src/renderer/react/components/feedback/FeedbackProvider.test.tsx`
- Create: `src/renderer/react/components/feedback/Feedback.css`
- Modify: `src/renderer/react/app/providers/AppProviders.tsx`

**Interfaces:**
- Consumes: Task 1 `FeedbackApi` and feedback constants; Ant Design `Modal.useModal` and `message.useMessage`.
- Produces: `FeedbackProvider` and `useFeedback(): FeedbackApi` for all React descendants.

- [ ] **Step 1: Write failing provider mapping tests**

Mock only the Ant Design hooks, render a probe under the provider, and assert exact mappings:

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackApi } from "../../../shared/feedback-types";

const messageOpen = vi.fn();
const modalConfirm = vi.fn();

vi.mock("antd", async () => {
  const React = await import("react");
  return {
    message: { useMessage: () => [{ open: messageOpen }, React.createElement("span")] },
    Modal: { useModal: () => [{ confirm: modalConfirm }, React.createElement("span")] },
  };
});

import { FeedbackProvider, useFeedback } from "./FeedbackProvider";

describe("FeedbackProvider", () => {
  let api: FeedbackApi;
  function Probe() { api = useFeedback(); return null; }

  it("maps notice tone, duration, dedupe key and class", async () => {
    const host = document.createElement("div");
    await act(async () => createRoot(host).render(<FeedbackProvider><Probe /></FeedbackProvider>));
    api!.notice({ tone: "success", message: "设置已保存" });
    expect(messageOpen).toHaveBeenCalledWith(expect.objectContaining({
      type: "success", content: "设置已保存", duration: 3, className: "cy-feedback-notice",
    }));
  });

  it("maps dangerous confirm to a cancel-focused modal", async () => {
    api!.confirm({ title: "删除任务？", message: "无法恢复。", dangerous: true });
    expect(modalConfirm).toHaveBeenCalledWith(expect.objectContaining({
      maskClosable: false,
      autoFocusButton: "cancel",
      okButtonProps: { danger: true },
      rootClassName: "cy-feedback-modal cy-feedback-modal--danger",
    }));
  });

  it("serializes blocking dialogs", async () => {
    const first = api!.alert({ tone: "info", title: "第一条", message: "先处理" });
    const second = api!.confirm({ title: "第二条", message: "后处理" });
    expect(modalConfirm).toHaveBeenCalledTimes(1);
    modalConfirm.mock.calls[0][0].onOk();
    await first;
    await Promise.resolve();
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    modalConfirm.mock.calls[1][0].onCancel();
    await expect(second).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the provider test and observe the missing module failure**

Run: `npm test -- src/renderer/react/components/feedback/FeedbackProvider.test.tsx`

Expected: FAIL because `FeedbackProvider` does not exist.

- [ ] **Step 3: Implement the provider and approved mappings**

Use Ant Design hook instances so the context holders live inside the application tree:

```tsx
import { CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Modal, message } from "antd";
import { createContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { AlertOptions, ConfirmOptions, FeedbackApi, FeedbackTone } from "../../../shared/feedback-types";

type ModalApi = ReturnType<typeof Modal.useModal>[0];

function toneIcon(tone: FeedbackTone): ReactNode {
  const icons: Record<FeedbackTone, ReactNode> = {
    success: <CheckCircleOutlined />,
    info: <InfoCircleOutlined />,
    warning: <WarningOutlined />,
    error: <CloseCircleOutlined />,
  };
  return icons[tone];
}

function FeedbackAlertContent({ message, details }: Pick<AlertOptions, "message" | "details">) {
  return (
    <div className="cy-feedback-alert__content">
      <p>{message}</p>
      {details ? <details><summary>查看详情</summary><pre>{details}</pre></details> : null}
    </div>
  );
}

function createConfirmPromise(
  modal: ModalApi,
  pending: Set<() => void>,
  options: ConfirmOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      pending.delete(cancel);
      resolve(value);
    };
    const cancel = () => settle(false);
    pending.add(cancel);
    modal.confirm({
      title: options.title,
      content: options.message,
      icon: toneIcon(options.tone ?? (options.dangerous ? "error" : "warning")),
      okText: options.confirmText ?? "确定",
      cancelText: options.cancelText ?? "取消",
      maskClosable: false,
      autoFocusButton: options.dangerous ? "cancel" : "ok",
      okButtonProps: options.dangerous ? { danger: true } : undefined,
      rootClassName: `cy-feedback-modal${options.dangerous ? " cy-feedback-modal--danger" : ""}`,
      onOk: () => settle(true),
      onCancel: cancel,
    });
  });
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [modal, modalHolder] = Modal.useModal();
  const [messageApi, messageHolder] = message.useMessage({ maxCount: FEEDBACK_NOTICE_MAX_COUNT });
  const pending = useRef(new Set<() => void>());
  const blockingTail = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  const enqueueBlocking = useCallback(<T,>(open: () => Promise<T>, fallback: T): Promise<T> => {
    const run = () => mounted.current ? open() : Promise.resolve(fallback);
    const result = blockingTail.current.then(run, run);
    blockingTail.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const api = useMemo<FeedbackApi>(() => ({
    notice(options) {
      options.focusTarget?.focus();
      void messageApi.open({
        key: `${options.tone}:${options.message}`,
        type: options.tone,
        content: options.message,
        duration: (options.durationMs ?? FEEDBACK_NOTICE_DURATION_MS) / 1000,
        className: "cy-feedback-notice",
      });
    },
    alert(options) {
      return enqueueBlocking(() => new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          pending.current.delete(settle);
          resolve();
        };
        pending.current.add(settle);
        modal.confirm({
          title: options.title,
          content: <FeedbackAlertContent message={options.message} details={options.details} />,
          icon: toneIcon(options.tone),
          cancelButtonProps: { style: { display: "none" } },
          okText: options.confirmText ?? "知道了",
          maskClosable: false,
          autoFocusButton: "ok",
          rootClassName: `cy-feedback-modal cy-feedback-modal--${options.tone}`,
          onOk: settle,
          onCancel: settle,
        });
      }), undefined);
    },
    confirm(options) {
      return enqueueBlocking(
        () => createConfirmPromise(modal, pending.current, options),
        false,
      );
    },
  }), [enqueueBlocking, messageApi, modal]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const settle of pending.current) settle();
      pending.current.clear();
    };
  }, []);

  return <FeedbackContext.Provider value={api}>{messageHolder}{modalHolder}{children}</FeedbackContext.Provider>;
}
```

`createConfirmPromise` accepts the same `Set<() => void>`, registers an idempotent cancellation closure for unmount cleanup, resolves `true` in `onOk`, resolves `false` in `onCancel`, and removes that closure after either result. It sets `maskClosable: false`, and uses `autoFocusButton: "cancel"` plus `okButtonProps: { danger: true }` when dangerous.

Add `FeedbackProvider` inside `AppProviders` after `useChatAppearance()` has initialized theme state.

- [ ] **Step 4: Add A-style Ant Design overrides and run tests**

In `Feedback.css`, scope all overrides below `.cy-feedback-modal` and `.cy-feedback-notice`, using the shared `--rb-feedback-*` variables. Import this stylesheet from `FeedbackProvider.tsx`.

Run: `npm test -- src/renderer/react/components/feedback/FeedbackProvider.test.tsx src/renderer/react/app/providers`

Expected: PASS; existing provider tests remain green.

- [ ] **Step 5: Commit the React adapter**

```powershell
git add -- src/renderer/react/components/feedback/FeedbackProvider.tsx src/renderer/react/components/feedback/FeedbackProvider.test.tsx src/renderer/react/components/feedback/Feedback.css
git add -p -- src/renderer/react/app/providers/AppProviders.tsx
git diff --cached --check
git commit -m "feat(react): add renderer feedback provider"
```

---

### Task 8: Migrate React call sites

**Files:**
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.test.ts`
- Modify: `src/renderer/react/features/chat/hooks/useComposerAttachments.ts`
- Modify: `src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`
- Modify: `src/renderer/react/features/chat/components/PluginModePanel.tsx`
- Modify: `src/renderer/react/features/chat/components/PluginModePanel.test.ts`
- Modify: `src/renderer/react/features/chat/components/ConversationSidebar.tsx`
- Create: `src/renderer/react/features/chat/components/ConversationSidebar.feedback.test.ts`
- Modify: `src/renderer/react/features/moments/MomentPostCard.tsx`
- Create: `src/renderer/react/features/moments/MomentPostCard.feedback.test.ts`

**Interfaces:**
- Consumes: Task 7 `useFeedback()`.
- Produces: all React user feedback through `FeedbackApi`; no direct browser dialogs and no direct `Modal.confirm` in feature code.

- [ ] **Step 1: Add failing feature-level assertions**

For `ChatPage.test.ts`, `useComposerAttachments.test.ts`, and `PluginModePanel.test.ts`, mock `../../../components/feedback/FeedbackProvider` with stable spies:

```ts
const notice = vi.fn();
const alert = vi.fn(() => Promise.resolve());
const confirm = vi.fn(() => Promise.resolve(true));

vi.mock("../../../components/feedback/FeedbackProvider", () => ({
  useFeedback: () => ({ notice, alert, confirm }),
}));
```

The chat feature tests use that same relative module path. `MomentPostCard.feedback.test.ts` uses `../../components/feedback/FeedbackProvider` because it lives directly under `features/moments`.

Add assertions for the actual user flow, for example:

```ts
expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
  title: expect.any(String),
  dangerous: true,
}));
expect(onDelete).toHaveBeenCalledWith(post.id);
```

For attachment ingestion failure:

```ts
expect(notice).toHaveBeenCalledWith(expect.objectContaining({
  tone: "error",
  message: expect.stringContaining("导入"),
}));
```

Add this source-focused test in `ConversationSidebar.feedback.test.ts`:

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./ConversationSidebar.tsx", import.meta.url)), "utf8");

describe("ConversationSidebar feedback", () => {
  it("awaits shared dangerous confirmation before deletion", () => {
    expect(source).toContain("useFeedback");
    expect(source).toMatch(/await feedback\.confirm\([\s\S]*dangerous: true[\s\S]*onDelete/);
    expect(source).not.toContain("Modal.confirm");
    expect(source).not.toContain("window.confirm");
  });
});
```

Create `MomentPostCard.feedback.test.ts` with this content:

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./MomentPostCard.tsx", import.meta.url)), "utf8");

describe("MomentPostCard feedback", () => {
  it("awaits shared dangerous confirmation before deleting a post", () => {
    const confirmIndex = source.indexOf("await feedback.confirm");
    const deleteIndex = source.indexOf("onDelete(post.id)", confirmIndex);
    expect(source).toContain("useFeedback");
    expect(source).toContain("dangerous: true");
    expect(source).not.toContain("window.confirm");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(confirmIndex);
  });
});
```

- [ ] **Step 2: Run affected tests and observe failures against direct browser dialogs**

Run: `npm test -- src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts src/renderer/react/features/chat/components/PluginModePanel.test.ts src/renderer/react/features/chat/components/ConversationSidebar.feedback.test.ts src/renderer/react/features/moments/MomentPostCard.feedback.test.ts`

Expected: FAIL because feature code has not called the mocked feedback API and the new source tests still find direct confirmation calls.

- [ ] **Step 3: Replace direct calls with semantic feedback**

At component or hook top level:

```ts
const feedback = useFeedback();
```

Then use asynchronous confirmation correctly:

```ts
const confirmed = await feedback.confirm({
  title: t("moments.delete"),
  message: t("moments.confirmDelete"),
  confirmText: t("moments.delete"),
  dangerous: true,
});
if (confirmed) onDelete(post.id);
```

Required mappings:

- `ChatPage.tsx`: report errors and short operation failures through error notices; workspace replacement, structure learning, and other destructive/overwriting choices through confirmation; long operation failures through alert.
- `useComposerAttachments.ts`: import failure, oversized pasted image, screenshot failure, and caption failure through notices; preserve existing translated text.
- `PluginModePanel.tsx`: plugin deletion through dangerous confirmation.
- `ConversationSidebar.tsx`: replace direct `Modal.confirm` with dangerous feedback confirmation and remove the `Modal` import when unused.
- `MomentPostCard.tsx`: post deletion through dangerous confirmation.

Every click handler awaiting confirmation must become `async`; event propagation behavior must remain unchanged.

- [ ] **Step 4: Run all affected React tests**

Run: `npm test -- src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts src/renderer/react/features/chat/components/PluginModePanel.test.ts src/renderer/react/features/chat/components/ConversationSidebar.feedback.test.ts src/renderer/react/features/moments/MomentPostCard.feedback.test.ts`

Expected: PASS with feedback spies receiving semantic options and business callbacks firing only after `confirm` resolves `true`.

- [ ] **Step 5: Commit only React migration hunks**

```powershell
git add -p -- src/renderer/react/features/chat/pages/ChatPage.tsx src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/hooks/useComposerAttachments.ts src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts src/renderer/react/features/chat/components/PluginModePanel.tsx src/renderer/react/features/chat/components/PluginModePanel.test.ts src/renderer/react/features/chat/components/ConversationSidebar.tsx src/renderer/react/features/moments/MomentPostCard.tsx
git add -- src/renderer/react/features/chat/components/ConversationSidebar.feedback.test.ts src/renderer/react/features/moments/MomentPostCard.feedback.test.ts
git diff --cached --check
git commit -m "refactor(react): replace default dialogs with feedback API"
```

---

### Task 9: Enforce the renderer boundary and complete verification

**Files:**
- Create: `src/renderer/default-dialogs-scanner.ts`
- Create: `src/renderer/default-dialogs-regression.test.ts`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: a permanent production-code guard against browser default dialogs while allowing Ant Design internals and Electron main-process native dialogs.

- [ ] **Step 1: Write a failing scanner and repository-boundary test**

Use the installed TypeScript compiler API（应用程序编程接口） instead of a regular expression so `modal.confirm()` is not mistaken for the browser global:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findDefaultDialogCalls } from "./default-dialogs-scanner";

const rendererRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|spec)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

describe("renderer default dialog boundary", () => {
  it("detects browser globals but ignores component methods", () => {
    expect(findDefaultDialogCalls("sample.ts", "alert('x'); window.confirm('y'); modal.confirm({});"))
      .toEqual(["sample.ts:1", "sample.ts:1"]);
  });

  it("uses no browser alert or confirm calls in production code", () => {
    const found = sourceFiles(rendererRoot).flatMap((file) =>
      findDefaultDialogCalls(path.relative(rendererRoot, file), fs.readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and observe the missing scanner failure**

Run: `npm test -- src/renderer/default-dialogs-regression.test.ts`

Expected: FAIL because `./default-dialogs-scanner` does not exist.

- [ ] **Step 3: Implement the TypeScript syntax-tree scanner and make the boundary green**

```ts
import path from "node:path";
import ts from "typescript";

export function findDefaultDialogCalls(file: string, source: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      const bare = ts.isIdentifier(target) && (target.text === "alert" || target.text === "confirm");
      const windowCall = ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression)
        && target.expression.text === "window"
        && (target.name.text === "alert" || target.name.text === "confirm");
      if (bare || windowCall) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${path.normalize(file)}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
```

Run: `npm test -- src/renderer/default-dialogs-regression.test.ts`

Expected: PASS with both the detector fixture and repository scan green. A repository offender means its owning migration task is incomplete; return to Task 5, 6, or 8 and correct that exact call before continuing.

- [ ] **Step 4: Run focused feedback and migration tests**

Run:

```powershell
npm test -- src/renderer/shared/feedback-types.test.ts src/renderer/settings/shared/dialog-focus.test.ts src/renderer/settings/shared/modal.test.ts src/renderer/settings/shared/modal-style.test.ts src/renderer/settings/default-dialogs-regression.test.ts src/renderer/react/components/feedback/FeedbackProvider.test.tsx src/renderer/default-dialogs-regression.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Run complete automated verification**

Run:

```powershell
npm test
npm run build:renderer
```

Expected: all Vitest files pass and Vite（前端构建工具） exits with code 0. Run the build only after confirming generated `dist/renderer` changes are expected or from an isolated worktree; do not overwrite unrelated user-generated assets in the dirty checkout.

Perform the manual checks from the spec:

- pearl-white and dark theme for success, error, dangerous confirm and input;
- narrow window and long Chinese/English paths;
- keyboard-only open, cancel, confirm and close;
- Electron file chooser and startup fatal error remain native.

- [ ] **Step 6: Commit the guard**

```powershell
git add -- src/renderer/default-dialogs-scanner.ts src/renderer/default-dialogs-regression.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test(ui): prevent browser default dialog regressions"
```

Do not stage `dist/renderer` unless the project explicitly tracks the generated output for this change and the diff contains only files produced by the verified renderer build.
