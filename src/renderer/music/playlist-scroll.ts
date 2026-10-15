/**
 * 歌单条的滚轮横向滚动。
 *
 * 歌单条（.mp-playlists）是横向滚动区，但隐藏了滚动条，普通鼠标的竖向滚轮也不会让它横向滚动。
 * 网易云歌单一多，后面的歌单既看不见也滚不到。这里把竖向滚轮换算成横向滚动。
 *
 * 返回新的 scrollLeft；不需要滚动时返回 null，调用方保持原样。
 */
export function wheelToHorizontalScroll(
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  deltaX: number,
  deltaY: number,
): number | null {
  // 内容没溢出：没有可滚的
  if (el.scrollWidth <= el.clientWidth) return null;
  // 触控板的横向手势本来就能横向滚动，只接管以竖向为主的滚轮
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return null;
  const max = el.scrollWidth - el.clientWidth;
  const next = Math.min(max, Math.max(0, el.scrollLeft + deltaY));
  return next === el.scrollLeft ? null : next;
}
