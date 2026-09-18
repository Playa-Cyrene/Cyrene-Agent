// 设置页弹窗焦点管理：初始聚焦、Tab 循环、Esc 取消、关闭后焦点恢复。
// 供 showModal / showAlert / showConfirm / showInputModal 共用。

// 可聚焦元素：按钮/表单控件之外，纳入 details 的 summary（技术详情折叠）与链接
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])';

/** 位于 hidden/inert/aria-hidden 容器内（如隐藏的详情区）的元素不参与焦点循环 */
function visibleFocusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

/**
 * 激活弹窗焦点管理。
 * @param dialog 弹窗根元素
 * @param initialFocus 打开后应立即聚焦的元素（通常为取消或确认按钮）
 * @param onEscape 按下 Esc 时的取消回调
 * @returns 清理函数：移除监听并把焦点恢复到触发元素
 */
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
    const focusable = visibleFocusables(dialog);
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
