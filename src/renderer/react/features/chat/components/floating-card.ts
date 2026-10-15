import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

export interface FloatingCardPosition { x: number; y: number }

export function clampFloatingCardPosition(
  position: FloatingCardPosition,
  card: { width: number; minVisibleHeight: number; minTop?: number },
  viewport: { width: number; height: number },
): FloatingCardPosition {
  const minTop = Math.min(Math.max(0, card.minTop ?? 0), Math.max(0, viewport.height - card.minVisibleHeight));
  return {
    x: Math.min(Math.max(0, position.x), Math.max(0, viewport.width - card.width)),
    y: Math.min(Math.max(minTop, position.y), Math.max(minTop, viewport.height - card.minVisibleHeight)),
  };
}

export function useFloatingCard(options: { width: number; top?: number; right?: number; containerRef?: RefObject<HTMLElement | null> }) {
  const { width, top = 80, right = 24, containerRef } = options;
  const getViewport = () => {
    const container = containerRef?.current;
    return container
      ? { width: container.clientWidth, height: container.clientHeight }
      : { width: window.innerWidth, height: window.innerHeight };
  };
  const getMinTop = () => containerRef?.current
    ?.querySelector<HTMLElement>(".cy-workspace-titlebar")
    ?.offsetHeight ?? 0;
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<FloatingCardPosition>({
    x: typeof window !== "undefined" ? getViewport().width - width - right : 0,
    y: top,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!containerRef?.current) return;
    const container = containerRef.current;
    const updateBounds = () => {
      const viewport = getViewport();
      setPosition((current) => clampFloatingCardPosition(current, {
        width,
        minVisibleHeight: 48,
        minTop: getMinTop(),
      }, viewport));
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(container);
    const titlebar = container.querySelector<HTMLElement>(".cy-workspace-titlebar");
    if (titlebar) observer.observe(titlebar);
    return () => observer.disconnect();
  }, [containerRef, width]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) setIsDragging(true);
      setPosition(clampFloatingCardPosition({
        x: drag.initialX + dx,
        y: drag.initialY + dy,
      }, {
        width,
        minVisibleHeight: 48,
        minTop: getMinTop(),
      }, getViewport()));
    };
    const handleUp = () => {
      dragRef.current = null;
      window.setTimeout(() => setIsDragging(false), 0);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [containerRef, width]);

  return {
    collapsed,
    position,
    toggle: () => setCollapsed((current) => !current),
    onHeaderMouseDown(event: ReactMouseEvent) {
      if ((event.target as HTMLElement).closest("[data-floating-toggle]")) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        initialX: position.x,
        initialY: position.y,
      };
    },
    onHeaderClick() {
      if (!isDragging) setCollapsed((current) => !current);
    },
  };
}
