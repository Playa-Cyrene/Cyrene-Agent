import { describe, expect, it } from "vitest";
import { SmoothTextRevealQueue, splitGraphemes, splitTextForReveal } from "./message-reveal";

describe("splitTextForReveal", () => {
  it("preserves the exact text while producing multiple reveal frames", () => {
    const text = "昔涟正在检查文件，然后会继续调用工具。";
    const chunks = splitTextForReveal(text, 8);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(8);
  });

  it("does not split surrogate pairs", () => {
    expect(splitTextForReveal("A🌸B", 3).join("")).toBe("A🌸B");
  });

  it("bounds the default reveal work for a long model message", () => {
    const chunks = splitTextForReveal("昔涟".repeat(500));

    expect(chunks.join("")).toBe("昔涟".repeat(500));
    expect(chunks.length).toBeLessThanOrEqual(24);
  });
});

describe("SmoothTextRevealQueue", () => {
  it("reveals the first small group immediately and preserves the remaining order", () => {
    const queue = new SmoothTextRevealQueue();
    const text = "好的伙伴，人家先去摸清这边项目的底";

    const first = queue.push(text);
    const chunks = [first];
    while (queue.hasPending) chunks.push(queue.takeNext(40));

    expect(first).toBe("好的伙");
    expect(chunks.join("")).toBe(text);
    expect(chunks.slice(1).every((chunk) => splitGraphemes(chunk).length >= 2)).toBe(true);
  });

  it("smoothly increases group size under a large backlog without exceeding nine graphemes", () => {
    const queue = new SmoothTextRevealQueue();
    queue.push("渐".repeat(300));

    const sizes = Array.from({ length: 8 }, () => splitGraphemes(queue.takeNext(40)).length);

    expect(sizes[0]).toBeGreaterThanOrEqual(3);
    expect(sizes.at(-1)).toBeGreaterThan(sizes[0]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(9);
  });

  it("never splits an emoji grapheme cluster", () => {
    const family = "👨‍👩‍👧‍👦";
    const queue = new SmoothTextRevealQueue();

    expect(splitGraphemes(`A${family}B`)).toEqual(["A", family, "B"]);
    expect(queue.push(`A${family}B`)).toBe(`A${family}B`);
  });
});
