import { describe, expect, it } from "vitest";
import { wheelToHorizontalScroll } from "./playlist-scroll";

const strip = (scrollLeft: number, scrollWidth = 1200, clientWidth = 600) => ({ scrollLeft, scrollWidth, clientWidth });

describe("wheelToHorizontalScroll", () => {
  it("竖向滚轮在歌单溢出时转成横向滚动", () => {
    expect(wheelToHorizontalScroll(strip(0), 0, 120)).toBe(120);
    expect(wheelToHorizontalScroll(strip(300), 0, -120)).toBe(180);
  });

  it("滚到两端时夹在可滚范围内，不越界", () => {
    expect(wheelToHorizontalScroll(strip(550), 0, 200)).toBe(600);
    expect(wheelToHorizontalScroll(strip(50), 0, -200)).toBe(0);
  });

  it("已经在尽头时不再处理（返回 null，交还默认行为）", () => {
    expect(wheelToHorizontalScroll(strip(600), 0, 120)).toBeNull();
    expect(wheelToHorizontalScroll(strip(0), 0, -120)).toBeNull();
  });

  it("歌单没有溢出时不处理", () => {
    expect(wheelToHorizontalScroll(strip(0, 500, 600), 0, 120)).toBeNull();
  });

  it("触控板横向手势不接管，保持浏览器原生横向滚动", () => {
    expect(wheelToHorizontalScroll(strip(0), 80, 10)).toBeNull();
  });
});
