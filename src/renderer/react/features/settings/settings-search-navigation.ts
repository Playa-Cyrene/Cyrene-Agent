/** Wait for asynchronously loaded panels without changing any setting values. */
export function locateSettingsSearchTarget(container: HTMLElement, id: string, onUnavailable: () => void): () => void {
  let highlighted: HTMLElement | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
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
    // Three complete light-and-back cycles, 500ms each (keep in sync with the CSS animation).
    highlightTimer = setTimeout(clearHighlight, 1500);
  }
  function locate() {
    const element = id.startsWith("section:")
      ? container.querySelector<HTMLElement>("h1")
      : Array.from(container.querySelectorAll<HTMLElement>("[data-settings-search-id]"))
        .find((node) => node.dataset.settingsSearchId === id);
    if (element && element.getClientRects().length) highlight(element);
  }
  observer.observe(container, { childList: true, subtree: true, attributes: true });
  locate();
  const timeout = setTimeout(() => {
    observer.disconnect();
    if (completed) return;
    const heading = container.querySelector<HTMLElement>("h1");
    if (heading) highlight(heading);
    onUnavailable();
  }, 3000);
  return () => {
    observer.disconnect();
    clearTimeout(timeout);
    clearTimeout(highlightTimer);
    clearHighlight();
  };
}
