import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import i18next from "i18next";
import { Search, X } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { PluginListEntry, PluginOverview } from "../../../../shared/plugin-management";
import type { SettingsSection } from "./AppearanceSettingsPage";
import { SETTINGS_NAV_ITEMS } from "./settingsNavItems";
import {
  buildCatalogEntries,
  buildPluginEntries,
  buildSettingEntries,
  searchSettings,
  type CatalogSearchSource,
  type SettingsSearchEntry,
} from "./settingsSearchIndex";
import "./SettingsSearch.css";

/** 侧栏收展动画时长（进/出对称）。 */
const MOVE_MS = 300;
/** 跳转后把目标项滚到居中的时长。 */
const SCROLL_MS = 300;
/** 给异步面板最多 5 秒挂载；超时释放观察器和监听器，避免旧搜索干扰之后的页面。 */
const LOOKUP_TIMEOUT_MS = 5000;
/** 闪烁 3 次：每次整条设置项底色变深灰 0.4s，再花 0.2s 复原。 */
const FLASH_TIMES = 3;
const FLASH_DARK_MS = 400;
const FLASH_BACK_MS = 200;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const EASE = "cubic-bezier(.4,0,.2,1)";

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function pluginEntriesOf(payload: PluginOverview | PluginListEntry[]): SettingsSearchEntry[] {
  return buildPluginEntries(Array.isArray(payload) ? payload : payload.plugins ?? []);
}

/** 不用尺寸判断可见性：挂载/布局阶段尺寸可能尚未更新。 */
function isVisible(element: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (node === root) break;
  }
  return true;
}

/** 身份标记只在当前内容区比较值，不拼 CSS 选择器，允许宿主 ID 含引号等特殊字符。 */
function findTarget(root: HTMLElement, entry: SettingsSearchEntry): HTMLElement | null {
  const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-settings-search-key], [data-settings-search-id]"));
  const anchor = anchors.find((node) => isVisible(node, root) && (entry.kind === "setting"
    ? !!entry.settingKey && node.dataset.settingsSearchKey === entry.settingKey
    : node.dataset.settingsSearchKind === entry.kind && node.dataset.settingsSearchId === entry.itemId));
  if (anchor) return anchor;
  // 运行时目录必须按身份定位；不在当前模式下就不闪，不能误选同名卡片。
  if (entry.kind !== "setting") return null;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,strong,span,label,button,p,div,li"))
    .filter((node) => node.textContent?.trim() === entry.label && isVisible(node, root))
    .filter((node) => {
      const key = node.closest<HTMLElement>("[data-settings-search-key]")?.dataset.settingsSearchKey;
      return !key || key === entry.settingKey;
    });
  const leaves = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)))
    .filter((node) => !node.querySelector("[data-settings-search-key]"));
  // 未标记的旧面板仅在目标唯一时回退到文本，宁可不闪也不闪错行。
  return leaves.length === 1 ? leaves[0] : null;
}

/** 仅展开面板显式登记的折叠区，不改变工具/技能的 Work、Code、Learn 模式。 */
function revealTarget(root: HTMLElement, entry: SettingsSearchEntry) {
  if (!entry.settingKey) return;
  for (const region of root.querySelectorAll<HTMLElement>("[data-settings-search-reveal]")) {
    if (!region.dataset.settingsSearchReveal?.split(" ").includes(entry.settingKey)) continue;
    region.querySelector<HTMLElement>('.ant-collapse-header[aria-expanded="false"]')?.click();
  }
}

/** 行容器候选：命中高亮和闪烁要作用在整条设置项上，而不是标题那几个字。
 *  工具/技能面板用自己的卡片类，不在这份名单里的面板会退化成只标标题。 */
const ROW_SELECTOR = ".cy-settings-row, .cy-model-field, .cy-settings-row__copy, .cy-settings-card, .tool-card, .skill-card, .plugin-card-ui, label";
const ROW_CLIMB_LIMIT = 5;

/** 优先最近的设置行，避免连同外层卡片里的其他设置一起闪烁；旧面板再回退到容器或标题。 */
function rowOf(title: HTMLElement, root: HTMLElement): HTMLElement {
  const row = title.closest<HTMLElement>(".cy-settings-row, .cy-model-field, .tool-card, .skill-card, .plugin-card-ui, .tool-panel__master, label");
  if (row && row !== root && root.contains(row)) return row;
  let node: HTMLElement | null = title.parentElement;
  let outermost: HTMLElement | null = null;
  for (let depth = 0; node && node !== root && depth < ROW_CLIMB_LIMIT; depth += 1) {
    if (node.matches(ROW_SELECTOR)) outermost = node;
    node = node.parentElement;
  }
  return outermost ?? title;
}

/** 最近的竖向滚动容器；找不到就用文档滚动。 */
function scrollContainerOf(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** 把元素滚到容器居中；容器不够长时贴到能到的最远端。 */
function scrollIntoCenter(container: HTMLElement | null, element: HTMLElement, duration: number): () => void {
  const containerTop = container?.getBoundingClientRect().top ?? 0;
  const elementTop = element.getBoundingClientRect().top;
  const viewportHeight = container?.clientHeight ?? window.innerHeight;
  const desired = (elementTop - containerTop) - (viewportHeight - element.offsetHeight) / 2;
  const maxScroll = container
    ? container.scrollHeight - container.clientHeight
    : document.documentElement.scrollHeight - window.innerHeight;
  const from = container ? container.scrollTop : window.scrollY;
  const to = Math.max(0, Math.min(maxScroll, from + desired));
  if (duration === 0) {
    if (container) container.scrollTop = to;
    else window.scrollTo(0, to);
    return () => {};
  }
  if (Math.abs(to - from) < 2) return () => {};
  let frame = 0;
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    const next = from + (to - from) * easeInOutCubic(progress);
    if (container) container.scrollTop = next;
    else window.scrollTo(0, next);
    if (progress < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/** 命中的文字用稍亮粉色标出（大小写无关，全部出现位置）。 */
function highlightMatch(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hit = lower.indexOf(needle, cursor);
  let order = 0;
  while (hit >= 0) {
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(<mark key={order++} className="cy-settings-search__mark">{text.slice(hit, hit + needle.length)}</mark>);
    cursor = hit + needle.length;
    hit = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export interface SettingsSearchProps {
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  getContentRoot: () => HTMLElement | null;
  /** 定位前仅恢复目标面板的浏览视图，不重挂载面板或修改宿主设置。 */
  onRevealEntry?: (entry: SettingsSearchEntry) => void;
}

export function SettingsSearch({ section, onSelectSection, getContentRoot, onRevealEntry }: SettingsSearchProps) {
  const { t, locale } = useTranslation();
  const resultsId = useId();
  const [active, setActive] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  /** 插件 / 工具 / 技能：宿主运行时目录，挂载与重新进入搜索时独立刷新。 */
  const [runtime, setRuntime] = useState<SettingsSearchEntry[]>([]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const keyboardSelectionRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const topBeforeLayout = useRef<number | null>(null);
  const navigationAbortRef = useRef<(() => void) | null>(null);

  // 语言切换即重建索引：静态条目取当前语言的资源树
  const settings = useMemo(
    () => buildSettingEntries(i18next.getResourceBundle(locale, "translation")),
    [locale],
  );
  const entries = useMemo(() => [...settings, ...runtime], [settings, runtime]);
  const results = useMemo(() => searchSettings(entries, query, 40), [entries, query]);

  /** 按大项聚成卡片；卡片顺序按该大项首个命中的排名。 */
  const groups = useMemo(() => {
    const buckets = new Map<SettingsSection, SettingsSearchEntry[]>();
    for (const entry of results) {
      const bucket = buckets.get(entry.section);
      if (bucket) bucket.push(entry);
      else buckets.set(entry.section, [entry]);
    }
    return Array.from(buckets, ([groupSection, items]) => ({
      groupSection,
      items,
      nav: SETTINGS_NAV_ITEMS.find((item) => item.section === groupSection),
    }));
  }, [results]);

  /** 键盘索引必须按卡片里的实际顺序数，否则分组重排后 Enter 会选错条目。 */
  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // 目录异步返回或语言切换会重排结果，不沿用旧列表中的位置。
  useLayoutEffect(() => {
    setActiveIndex(0);
    keyboardSelectionRef.current = false;
    // 查询、语言或目录刷新都可能重排列表；首项与视口必须一起复位，避免 Enter 选择屏外项。
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [ordered]);
  useEffect(() => () => navigationAbortRef.current?.(), []);

  useLayoutEffect(() => {
    if (!keyboardSelectionRef.current) return;
    keyboardSelectionRef.current = false;
    const container = resultsRef.current;
    const item = container?.querySelector<HTMLElement>(".cy-settings-search__item.is-active");
    if (!container || !item) return;
    // 只调整结果列表，保留输入焦点，避免 scrollIntoView 连带滚动整个设置页。
    const viewport = container.getBoundingClientRect();
    const bounds = item.getBoundingClientRect();
    const top = viewport.top + container.clientTop;
    const bottom = top + container.clientHeight;
    if (bounds.top < top) container.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) container.scrollTop += bounds.bottom - bottom;
  }, [activeIndex]);

  useEffect(() => {
    let disposed = false;
    const update = (kind: SettingsSearchEntry["kind"], entries: SettingsSearchEntry[]) => {
      if (!disposed) setRuntime((current) => [...current.filter((entry) => entry.kind !== kind), ...entries]);
    };
    // 每一路独立提交结果；某个 IPC 一直 pending 也不能阻塞其他目录。
    // 用微任务调用也能捕获宿主接口的同步异常；清理标记隔离旧请求返回值。
    void Promise.resolve().then(() => window.plugins?.list() ?? [])
      .then((value) => update("plugin", pluginEntriesOf(value))).catch(() => update("plugin", []));
    for (const kind of ["tool", "skill"] as const) {
      void Promise.resolve().then(() => kind === "tool" ? window.settings?.getToolCatalog?.() : window.settings?.getSkillCatalog?.())
        .then((value) => update(kind, buildCatalogEntries(Array.isArray(value) ? value as CatalogSearchSource[] : [], kind, kind === "tool" ? "toolToggle" : "skill")))
        .catch(() => update(kind, []));
    }
    return () => { disposed = true; };
  }, [catalogRevision]);

  /** FLIP：记住动画前的位置，布局变化后反向平移回来，再缓动到新位置。 */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const current = box.getBoundingClientRect().top;
    const previous = topBeforeLayout.current;
    topBeforeLayout.current = current;
    // CSS 媒体查询无法覆盖内联 FLIP 过渡，脚本必须同样遵循系统偏好。
    if (prefersReducedMotion()) {
      box.style.transition = "none";
      box.style.transform = "none";
      return;
    }
    if (previous === null) return;
    const delta = previous - current;
    if (Math.abs(delta) < 1) return;
    box.style.transition = "none";
    box.style.transform = `translateY(${delta}px)`;
    void box.offsetWidth;
    box.style.transition = `transform ${MOVE_MS}ms ${EASE}`;
    box.style.transform = "translateY(0)";
  }, [active]);

  // Escape 关闭后保留输入焦点，点击和输入也需走此入口，不能只依赖下一次 focus。
  function enter() {
    navigationAbortRef.current?.();
    if (active) return;
    topBeforeLayout.current = boxRef.current?.getBoundingClientRect().top ?? null;
    setActive(true);
    setCatalogRevision((revision) => revision + 1);
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  function leave() {
    if (!active) return;
    // 先移回仍可见的输入框，再隐藏关闭按钮；此时 onFocus 仍看到搜索态，不会重新展开。
    inputRef.current?.focus({ preventScroll: true });
    topBeforeLayout.current = boxRef.current?.getBoundingClientRect().top ?? null;
    setActive(false);
    setQuery("");
  }

  // 一次跳转独占观察器、定时器、动画帧和事件监听器；统一停止以防新旧跳转争抢滚动位置。
  const locate = useCallback((entry: SettingsSearchEntry) => {
    navigationAbortRef.current?.();
    let stopped = false;
    let found = false;
    let row: HTMLElement | null = null;
    let cancelScroll: (() => void) | undefined;
    let observer: MutationObserver | undefined;
    const timers: number[] = [];
    const events = ["pointerdown", "wheel", "keydown", "touchstart"] as const;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer?.disconnect();
      timers.forEach((id) => window.clearTimeout(id));
      cancelScroll?.();
      row?.classList.remove("cy-settings-search-flash", "cy-settings-search-flash-host");
      for (const event of events) window.removeEventListener(event, stop, true);
      if (navigationAbortRef.current === stop) navigationAbortRef.current = null;
    };
    navigationAbortRef.current = stop;
    // 从查找阶段就交还用户控制权，覆盖滚动、等待闪烁以及闪烁本身。
    for (const event of events) window.addEventListener(event, stop, { capture: true, passive: true });
    const later = (fn: () => void, delay: number) => timers.push(window.setTimeout(() => { if (!stopped) fn(); }, delay));
    const flash = () => {
      row!.classList.add("cy-settings-search-flash-host");
      for (let index = 0; index < FLASH_TIMES; index += 1) {
        const start = index * (FLASH_DARK_MS + FLASH_BACK_MS);
        later(() => row!.classList.add("cy-settings-search-flash"), start);
        later(() => row!.classList.remove("cy-settings-search-flash"), start + FLASH_DARK_MS);
      }
      later(stop, FLASH_TIMES * (FLASH_DARK_MS + FLASH_BACK_MS) + 40);
    };
    const lookup = () => {
      if (stopped || found) return;
      const root = getContentRoot();
      if (!root) return;
      revealTarget(root, entry);
      const target = findTarget(root, entry);
      if (!target) return;
      found = true;
      observer?.disconnect();
      row = rowOf(target, root);
      const duration = prefersReducedMotion() ? 0 : SCROLL_MS;
      cancelScroll = scrollIntoCenter(scrollContainerOf(row) ?? scrollContainerOf(target), row, duration);
      later(flash, duration + 20);
    };
    // 在 React 提交跳页后开始观察；观察最近的内容根，根尚未挂载时暂借 body。
    later(() => {
      observer = new MutationObserver(lookup);
      observer.observe(getContentRoot() ?? document.body, { childList: true, subtree: true, attributes: true });
      lookup();
    }, 0);
    later(() => { if (!found) stop(); }, LOOKUP_TIMEOUT_MS);
  }, [getContentRoot]);

  function pick(entry: SettingsSearchEntry) {
    leave();
    if (entry.section !== section) onSelectSection(entry.section);
    onRevealEntry?.(entry);
    locate(entry);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // 输入法确认/取消候选词不等于操作搜索；部分输入法只提供 229 而未标记 isComposing。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !active) return;
    if (event.key === "Escape") { leave(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!ordered.length) return;
      event.preventDefault();
      keyboardSelectionRef.current = true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + step + ordered.length) % ordered.length);
      return;
    }
    if (event.key === "Enter") {
      const entry = ordered[activeIndex];
      if (entry) { event.preventDefault(); pick(entry); }
    }
  }

  const hasResults = active && !!query.trim() && ordered.length > 0;
  const optionId = (index: number) => `${resultsId}-option-${index}`;
  let ordinal = -1;
  const renderItem = (entry: SettingsSearchEntry, groupIcon: ReactNode) => {
    ordinal += 1;
    const index = ordinal;
    return (
      <button
        key={`${entry.section}-${entry.label}-${index}`}
        type="button"
        id={optionId(index)}
        role="option"
        aria-selected={index === activeIndex}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        className={`cy-settings-search__item${index === activeIndex ? " is-active" : ""}`}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => pick(entry)}
      >
        {/* 每个大项只在该组首行显示图标，其余行留同宽空距，保证标题左对齐 */}
        <span className="cy-settings-search__item-icon" aria-hidden="true">{groupIcon}</span>
        <span className="cy-settings-search__item-text">
          <span className="cy-settings-search__item-label">{highlightMatch(entry.label, query)}</span>
          {entry.detail && <span className="cy-settings-search__item-detail">{highlightMatch(entry.detail, query)}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className={`cy-settings-search${active ? " is-active" : ""}`}>
      <div className="cy-settings-search__bar" ref={boxRef}>
        <div className="cy-settings-search__field">
          <Search className="cy-settings-search__icon" size={15} strokeWidth={2} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cy-settings-search__input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={hasResults}
            aria-controls={hasResults ? resultsId : undefined}
            aria-activedescendant={hasResults && ordered[activeIndex] ? optionId(activeIndex) : undefined}
            placeholder={t("settingsPage.search.placeholder")}
            aria-label={t("settingsPage.search.placeholder")}
            value={query}
            onFocus={enter}
            onClick={enter}
            onChange={(event) => { enter(); setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button type="button" className="cy-settings-search__clear" aria-label={t("settingsPage.search.clear")}
              onClick={() => { setQuery(""); setActiveIndex(0); inputRef.current?.focus(); }}>
              <X size={11} strokeWidth={2.6} aria-hidden="true" />
            </button>
          )}
        </div>
        {/* 常驻 DOM 才能播宽度收展动画；非搜索态用 aria-hidden + tabIndex 摘出去 */}
        <button
          type="button"
          className={`cy-settings-search__close${active ? " is-active" : ""}`}
          aria-label={t("settingsPage.search.close")}
          aria-hidden={active ? undefined : "true"}
          tabIndex={active ? 0 : -1}
          onClick={leave}
        >
          <X size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      {active && query.trim() && (
        groups.length === 0 ? (
          <div className="cy-settings-search__empty" role="status">{t("settingsPage.search.empty")}</div>
        ) : (
          <div className="cy-settings-search__results" ref={resultsRef} id={resultsId} role="listbox" aria-label={t("settingsPage.search.placeholder")}>
            {groups.map((group) => (
              <div className="cy-settings-search__group-card" key={group.groupSection} role="group" aria-label={group.nav ? t(group.nav.labelKey) : undefined}>
                {group.items.map((entry, position) => renderItem(entry, position === 0 ? group.nav?.icon : null))}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
