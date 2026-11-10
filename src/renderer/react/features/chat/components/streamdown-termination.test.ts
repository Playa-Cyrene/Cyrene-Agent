import { describe, expect, it, vi } from "vitest";
import remend from "remend";
import * as streamdown from "streamdown";
import { createMessageRemendOptions } from "./streamdown-termination";
import * as math from "./streamdown-math";

vi.mock("streamdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("streamdown")>();
  return { ...original, parseMarkdownIntoBlocks: vi.fn(original.parseMarkdownIntoBlocks) };
});

function complete(input: string): string {
  return remend(input, createMessageRemendOptions());
}

describe("math-safe streaming completion", () => {

  it.each([
    "$$\nx^2\n$",
    "$$\nx^2\n",
    "$$\n\\text{cost }\\$5\n$",
    "$x\\in [0,1)$",
  ])("retains native dollar closing completion and escaped dollars: %s", (input) => {
    const expected = input.startsWith("$$") ? remend(input) : input;
    expect(complete(input)).toBe(expected);
  });

  it("uses original coordinates when locked block parsing drops duplicate definitions", () => {
    const defs = "[r]: https://example.com\n[r]: https://example.com\n\n";
    const formula = String.raw`\(x\in [0,1)\)`;
    const input = defs + formula + "\n\n![示意](https://example.com/a";
    expect(streamdown.parseMarkdownIntoBlocks(input).join("")).not.toBe(input);
    expect(complete(input)).toBe(defs + formula + "\n\n![示意](streamdown:incomplete-image)");
  });

  it("falls back safely for any block result that cannot reconstruct its source", () => {
    const split = vi.mocked(streamdown.parseMarkdownIntoBlocks).mockReturnValueOnce(["unrelated"]);
    try {
      const formula = String.raw`\(x\in [0,1)\)`;
      expect(complete(formula + "\n\n[链接](https://example.com/a"))
        .toBe(formula + "\n\n[链接](streamdown:incomplete-link)");
    } finally {
      split.mockReset();
    }
  });

  it("keeps the lossy-map fallback cached while text grows and recovers after replacement", () => {
    const analyze = vi.spyOn(math, "getStreamingMathRanges");
    try {
      const options = createMessageRemendOptions();
      const frozen = "[r]: https://example.com\n[r]: https://example.com\n\n" + String.raw`\(x\in [0,1)\)` + "\n\n";
      remend(frozen + "后文", options);
      analyze.mockClear();
      for (const tail of ["后文一", "后文一二", "后文一二三"]) expect(remend(frozen + tail, options)).toBe(frozen + tail);
      expect(analyze).toHaveBeenCalled();
      expect(analyze.mock.calls.every(([source]) => !source.includes("[r]:") && !source.includes("\\(x"))).toBe(true);
      const formula = String.raw`\(y\in [1,2)\)`;
      expect(remend(formula + "\n\n![示意](https://example.com/a", options))
        .toBe(formula + "\n\n![示意](streamdown:incomplete-image)");
    } finally {
      analyze.mockRestore();
    }
  });
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
