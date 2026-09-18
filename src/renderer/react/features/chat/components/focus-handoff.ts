/**
 * 焦点释放工具：在文件树面板被 Tabs 隐藏前，把仍停留在其内部的焦点移回 body，
 * 避免 aria-hidden 区域持有 document.activeElement 触发无障碍警告。
 *
 * 只处理"容器内含焦点"的情况；焦点在容器外时不做任何操作。
 */
export function releaseFocusedDescendant(container: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!container || !(active instanceof HTMLElement) || !container.contains(active)) {
    return false;
  }
  active.blur();
  return true;
}
