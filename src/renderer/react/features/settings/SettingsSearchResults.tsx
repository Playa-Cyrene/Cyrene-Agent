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

/** Unvisited rows reserve space only; their content mounts when it enters this list's viewport. */
export function SettingsSearchResults({ items, active, browsing, direction, containerRef, translate, onActivate, onActiveChange }: Props) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
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
    // Layout-based fallback for environments without IntersectionObserver.
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
    const resize = new ResizeObserver(reveal);
    resize.observe(container);
    return () => { container.removeEventListener("scroll", reveal); resize.disconnect(); };
    // The parent keys this component by the result identities and current page.
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
      // Scrolling/animations can move a row beneath a stationary pointer. Only actual movement takes selection back.
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
