import { describe, expect, it, vi } from "vitest";
import remend from "remend";
import { createMessageRemendOptions } from "./streamdown-termination";
import * as math from "./streamdown-math";

function complete(input: string): string {
  return remend(input, createMessageRemendOptions());
}

describe("math-safe streaming completion", () => {
  it.each([
    String.raw`\(x\in [0,1)\)`, String.raw`\(x\in [0,1)`,
    String.raw`\[x\in [0,1)\]`, String.raw`\[x\in [0,1)`,
    String.raw`$x\in [0,1)$`, "$$\nx\\in [0,1)\n$$",
    String.raw`\(f([a,b),\{x\})\)`,
  ])("keeps complete and incomplete mathematical syntax exact: %s", (input) => {
    expect(complete(input)).toBe(input);
  });

  it.each([
    "普通文字", "**加粗", "*强调", "~~删除", "`inline", "```ts\nconst a=1;",
    "[链接](https://example.com/a", "![示意](https://example.com/a",
    "**文字 [链接](https://example.com/a", "*文字 ![示意](https://example.com/a",
    "- > 25", "20~25", "text <unfinished", "[引用][ref]\n\n[ref]: https://example.com",
    "```text\n\\[\n```\n\n![示意](https://example.com/a",
    "<code>\\[</code>\n\n![示意](https://example.com/a",
    "[文档](https://example.com/\\[)\n\n[链接](https://example.com/a",
  ])("retains native completion outside math: %s", (input) => {
    expect(complete(input)).toBe(remend(input));
  });

  it("restores math even when native link completion returns early, without token collisions", () => {
    const formula = "\\(\\text{\uE0000\uE001} + [0,1)\\)";
    expect(complete(formula + "\n\n![示意](https://example.com/a"))
      .toBe(formula + "\n\n![示意](streamdown:incomplete-image)");
    expect(complete(formula + "\n\n[链接](https://example.com/a"))
      .toBe(formula + "\n\n[链接](streamdown:incomplete-link)");
  });


  it("also reuses completed top-level nodes when footnotes make Streamdown use one block", () => {
    const analyze = vi.spyOn(math, "getStreamingMathRanges");
    try {
      const options = createMessageRemendOptions();
      const frozen = String.raw`\(x\)` + "\n\n正文[^n]\n\n[^n]: 注释\n\n";
      remend(frozen + "后文", options);
      analyze.mockClear();
      for (const suffix of ["后文一", "后文一二", "后文一二三"]) remend(frozen + suffix, options);
      expect(analyze).toHaveBeenCalled();
      expect(analyze.mock.calls.every(([source]) => !source.includes("\\(x"))).toBe(true);
      expect(analyze.mock.calls.every(([source]) => !source.includes("[^n]"))).toBe(true);
    } finally {
      analyze.mockRestore();
    }
  });

  it("reuses frozen block analysis rather than parsing the growing document", () => {
    const analyze = vi.spyOn(math, "getStreamingMathRanges");
    try {
      const options = createMessageRemendOptions();
      const frozen = String.raw`\(x\in [0,1)\)` + "\n\n";
      remend(frozen + "后文", options);
      analyze.mockClear();
      for (const suffix of ["后文一", "后文一二", "后文一二\n\n第三段"]) {
        remend(frozen + suffix, options);
      }
      expect(analyze).toHaveBeenCalled();
      expect(analyze.mock.calls.every(([source]) => !source.includes("\\(x"))).toBe(true);
      expect(analyze.mock.calls.every(([source]) => !source.includes("\n\n第三段"))).toBe(true);
      expect(complete(String.raw`\[unclosed`)).toBe(String.raw`\[unclosed`);
      remend("完全替换\n\n![示意](https://example.com/a", options);
      expect(remend(frozen + "[链接](https://example.com/a", options))
        .toBe(frozen + "[链接](streamdown:incomplete-link)");
    } finally {
      analyze.mockRestore();
    }
  });
});
