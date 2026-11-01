import { ChevronRight, Search } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SettingsSearchItem } from "./settings-search-index";

export type SearchTransitionDirection = "forward" | "back";

interface Props {
  items: SettingsSearchItem[];
  active: number;
  browsing: boolean;
  direction: SearchTransitionDirection;
  containerRef: RefObject<HTMLDivElement | null>;
  translate: (key: string) => string;
  onActivate: (item: SettingsSearchItem) => void;
  onActiveChange: (index: number) => void;
}

/** 未访问的结果只占位，进入列表视口后才挂载内容，避免提前播放屏幕外项目的动画。 */
export function SettingsSearchResults({ items, active, browsing, direction, containerRef, translate, onActivate, onActiveChange }: Props) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  // 记录当前层已加载的项目，防止滚回时重播；换层通过外层 key 重建组件，旧记录随卸载释放。
  const seen = useRef(new Map<number, number>());
  const nextStart = useRef(0);
  const lastMousePosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const [loaded, setLoaded] = useState(new Map<number, number>());
  const [finished, setFinished] = useState(new Set<number>());
  const headingAt = (index: number) => !browsing && items[index].section !== items[index - 1]?.section && !items[index].id.startsWith("section:");

  const load = useCallback((indices: number[]) => {
    const fresh = [...new Set(indices)].filter((index) => !seen.current.has(index)).sort((a, b) => a - b);
    if (!fresh.length) return;
    const now = performance.now();
    const start = Math.max(now, nextStart.current);
    fresh.forEach((index, order) => seen.current.set(index, start - now + order * 50));
    nextStart.current = start + fresh.length * 50;
    setLoaded(new Map(seen.current));
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    if (typeof IntersectionObserver !== "undefined") {
      // 首次加载后停止观察该行；换层或卸载时断开观察，并忽略已排队的迟到回调。
      const observer = new IntersectionObserver((entries) => {
        if (disposed) return;
        const indices = entries.filter((entry) => entry.isIntersecting && entry.intersectionRatio > 0)
          .map((entry) => Number((entry.target as HTMLElement).dataset.searchRow));
        load(indices);
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio > 0) observer.unobserve(entry.target);
      }, { root: container, threshold: 0 });
      rows.current.forEach((row) => row && observer.observe(row));
      return () => { disposed = true; observer.disconnect(); };
    }
    // 缺少 IntersectionObserver 时按布局计算可见项目，保持相同的按需加载行为。
    const reveal = () => {
      const height = container.clientHeight || Math.min(window.innerHeight * 0.4, 360);
      let top = 0;
      const indices: number[] = [];
      rows.current.forEach((row, index) => {
        const rowHeight = row?.offsetHeight || 44 + (headingAt(index) ? 34 : 0);
        if (top < container.scrollTop + height && top + rowHeight > container.scrollTop) indices.push(index);
        top += rowHeight;
      });
      load(indices);
    };
    reveal();
    container.addEventListener("scroll", reveal, { passive: true });
    // 此分支的滚动监听器和尺寸观察器共用下面的清理函数，换层或卸载时一并释放。
    const resize = new ResizeObserver(reveal);
    resize.observe(container);
    return () => { container.removeEventListener("scroll", reveal); resize.disconnect(); };
    // 外层 key 包含当前层级和结果身份；结果改变时会重建组件，不沿用旧行索引。
  }, [load, containerRef]);

  useLayoutEffect(() => {
    const row = rows.current[active];
    if (!row) return;
    load([active]);
    row.scrollIntoView({ block: "nearest" });
  }, [active, load]);

  return <div id="settings-search-results" className="cy-settings-search__results" ref={containerRef} role="listbox" aria-label={translate("settingsSearch.results")}
    onMouseMove={(event) => {
      const previous = lastMousePosition.current;
      if (previous?.x === event.clientX && previous.y === event.clientY) return;
      lastMousePosition.current = { x: event.clientX, y: event.clientY };
      // 滚动或动画会让项目经过静止鼠标下方；只有鼠标坐标改变时才接回选择，避免抢走键盘焦点。
      const option = (event.target as HTMLElement).closest<HTMLElement>("[data-result-index]");
      if (option && event.currentTarget.contains(option)) onActiveChange(Number(option.dataset.resultIndex));
    }}>
    {items.map((item, index) => <div key={item.id} ref={(node) => { rows.current[index] = node; }} data-search-row={index}
      className="cy-settings-search__row-slot" role="presentation" aria-hidden={loaded.has(index) ? undefined : true}
      style={{ minHeight: 44 + (headingAt(index) ? 34 : 0) }}>
      {loaded.has(index) && <div className={`cy-settings-search__row-content${finished.has(index) ? "" : " is-entering"}`}
        data-direction={direction} style={{ animationDelay: `${loaded.get(index)}ms` }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setFinished((current) => new Set(current).add(index));
        }}>
        {headingAt(index) && <div className="cy-settings-search__section" role="presentation">{translate(item.sectionKey)}</div>}
        <button type="button" id={`settings-search-result-${index}`} data-result-index={index} role="option" aria-selected={index === active}
          aria-posinset={index + 1} aria-setsize={items.length}
          className={`cy-settings-search__result${index === active ? " is-active" : ""}`} onFocus={() => onActiveChange(index)} onClick={() => onActivate(item)}>
          <Search size={15} /><span><strong>{translate(item.titleKey)}</strong></span><ChevronRight size={14} />
        </button>
      </div>}
    </div>)}
    {!items.length && <p className="cy-settings-search__empty" role="status">{translate("settingsSearch.empty")}</p>}
  </div>;
}
