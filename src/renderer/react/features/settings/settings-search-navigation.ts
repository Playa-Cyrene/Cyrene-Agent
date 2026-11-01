/** 等待异步面板后定位目标；不修改设置值，返回的清理函数供页面离开或卸载时取消。 */
export function locateSettingsSearchTarget(container: HTMLElement, id: string, onUnavailable: () => void): () => void {
  let highlighted: HTMLElement | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  // 定位成功或等待超时后停止观察；提前离开页面时由返回的清理函数停止。
  const observer = new MutationObserver(locate);

  function clearHighlight() {
    highlighted?.classList.remove("cy-settings-search-highlight", "cy-settings-search-highlight--item");
  }
  function highlight(element: HTMLElement) {
    completed = true;
    observer.disconnect();
    const item = element.closest<HTMLElement>(".cy-settings-row, .cy-model-field, .cy-model-switch-row, .cy-tts-field-switch");
    highlighted = item ?? element.closest<HTMLElement>(".cy-settings-section__heading") ?? element;
    highlighted.scrollIntoView({ block: "center", behavior: "smooth" });
    highlighted.classList.add("cy-settings-search-highlight");
    if (item) highlighted.classList.add("cy-settings-search-highlight--item");
    // 每次变浅并恢复为 500ms，共三次；正常结束移除提示，提前离开时清理函数取消计时和样式。
    highlightTimer = setTimeout(clearHighlight, 1500);
  }
  function unavailable() {
    if (completed) return;
    completed = true;
    observer.disconnect();
    onUnavailable();
  }
  function locate() {
    if (completed) return;
    const element = id.startsWith("section:")
      ? container.querySelector<HTMLElement>("h1")
      : Array.from(container.querySelectorAll<HTMLElement>("[data-settings-search-id]"))
        .find((node) => node.dataset.settingsSearchId === id);
    if (element && element.getClientRects().length) { highlight(element); return; }
    // 面板完成加载后才能判定条件项缺失，不用等待固定超时。
    if (container.querySelector('[data-settings-search-loading="false"]')) unavailable();
  }
  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-settings-search-loading"] });
  locate();
  // 未声明加载状态的旧面板保留三秒兜底；已声明且仍在加载的面板继续等待。
  // 三十秒上限防止请求永久挂起；离开页面时同时清理两个计时器。
  const timeout = setTimeout(() => {
    if (!container.querySelector('[data-settings-search-loading="true"]')) unavailable();
  }, 3000);
  const loadingTimeout = setTimeout(unavailable, 30000);
  return () => {
    observer.disconnect();
    clearTimeout(timeout);
    clearTimeout(loadingTimeout);
    clearTimeout(highlightTimer);
    clearHighlight();
  };
}
