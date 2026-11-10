import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import { defaultRemarkPlugins } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { unified } from "unified";
import { containsBackslashMath, findBackslashMath, messageMathPlugin } from "./streamdown-math";

const parser = unified().use(remarkParse).use([defaultRemarkPlugins.gfm, messageMathPlugin.remarkPlugin]);
const nativeParser = unified().use(remarkParse).use([defaultRemarkPlugins.gfm, createMathPlugin({ singleDollarTextMath: true }).remarkPlugin]);

interface Node { type: string; value?: string; children?: Node[] }
function mathValues(input: string): string[] {
  const values: string[] = [];
  function visit(node: Node) {
    if (node.type === "inlineMath" || node.type === "math") values.push(node.value!);
    node.children?.forEach(visit);
  }
  visit(parser.parse(input));
  return values;
}

describe("backslash math tokenizer", () => {

  it.each(["paragraph", "separate paragraph", "inline code", "formula body"])("has bounded scan growth for a long slash run in %s", (layout) => {
    const build = (length: number) => {
      const run = "\\".repeat(length);
      if (layout === "formula body") return "\\(x " + run + " y\\)";
      return String.raw`\(x\) ` + (layout === "inline code" ? "`" + run + "`" : layout === "separate paragraph" ? "\n\n" + run : run + " end");
    };
    const reads = (length: number) => {
      const input = build(length);
      const tree = nativeParser.parse(input);
      let count = 0;
      // 只统计扫描器读取字符的工作量，原生 AST 仍由真实字符串解析。
      const observed = new Proxy(new String(input), {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            count += 1;
            if (count > length * 8) throw new Error(`scan exceeded linear read budget: ${count} for ${length} slashes`);
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(input) : value;
        },
      }) as unknown as string;
      expect(findBackslashMath(observed, tree).size).toBe(1);
      return count;
    };
    const small = reads(5000);
    const large = reads(20000);
    // 输入增长 4 倍，字符读取量也至多线性增长；不依赖机器速度或 GC。
    expect(large).toBeLessThanOrEqual(small * 4.1);
    expect(large).toBeLessThan(20000 * 8);
  });

  it.each([
    String.raw`\(a \(b\) + \(c\)\)`,
    String.raw`\[a \[b\] + \[c\]\]`,
    String.raw`\(a \[b\] + \(c\)\)`,
    String.raw`\[a \(b\) + \[c\]\]`,
    String.raw`\(a \(b\) + \(c\)`,
    String.raw`\[a \[b\] + \[c\]`,
    String.raw`\(a \[b\] + \[c\]`,
    String.raw`\[a \(b\) + \(c\)`,
  ])("keeps the entire container native for multiple nested groups: %s", (input) => {
    expect(mathValues(input)).toEqual([]);
    expect(parser.parse(input)).toEqual(nativeParser.parse(input));
    expect(containsBackslashMath(input)).toBe(false);
  });

  it("limits conservative rejection to the affected container", () => {
    const nested = String.raw`\(a \(b\) + \(c\)\)`;
    const sameParagraph = String.raw`\(p\) before ` + nested + String.raw` after \(q\)`;
    expect(parser.parse(sameParagraph)).toEqual(nativeParser.parse(sameParagraph));
    expect(mathValues(String.raw`\(p\)` + "\n\n" + nested + "\n\n" + String.raw`\(q\)`))
      .toEqual(["p", "q"]);
    const aligned = String.raw`\begin{aligned}a&=b\\[4pt]c&=d\end{aligned}`;
    expect(mathValues(String.raw`\(p\) ` + `\\(${aligned}\\)` + String.raw` \(q\)`))
      .toEqual(["p", aligned, "q"]);
  });

  it.each(["(", "["])("distinguishes escaped row-spacing syntax from nested delimiters inside %s", (opener) => {
    const closer = opener === "(" ? ")" : "]";
    const wrap = (body: string) => `\\${opener}${body}\\${closer}`;
    for (const tex of [
      String.raw`\begin{aligned}a&=b\\[4pt]c&=d\end{aligned}`,
      String.raw`\begin{matrix}a&b\\[4pt]c&d\end{matrix}`,
    ]) {
      expect(mathValues(wrap(tex))).toEqual([tex]);
      expect(containsBackslashMath(wrap(tex))).toBe(true);
    }
    for (const inner of ["(", "["]) {
      for (const count of [1, 2, 3, 4]) {
        const body = "x " + "\\".repeat(count) + inner + "4pt] y";
        const input = wrap(body);
        if (count % 2 === 0) {
          expect(mathValues(input), input).toEqual([body]);
          expect(containsBackslashMath(input), input).toBe(true);
        } else {
          expect(parser.parse(input), input).toEqual(nativeParser.parse(input));
          expect(containsBackslashMath(input), input).toBe(false);
        }
      }
    }
  });

  it.each([
    String.raw`\(a \(b\) c\)`,
    String.raw`\(a \[b\] c\)`,
    String.raw`\[a \(b\) c\]`,
    String.raw`\[a \[b\] c\]`,
  ])("preserves truly nested delimiters: %s", (input) => {
    expect(mathValues(input)).toEqual([]);
    expect(parser.parse(input)).toEqual(nativeParser.parse(input));
    expect(containsBackslashMath(input)).toBe(false);
  });
  const untouched = [
    String.raw`\[incomplete but \(x\)`,
    String.raw`\(not closed`, String.raw`\[not closed`, String.raw`\(\)`, String.raw`\[ \]`,
    String.raw`\\(escaped\\)`, String.raw`\\[escaped\\]`,
    String.raw`$\(already math\)$`, String.raw`$$\[already math\]$$`,
    "$$\n\\[already math\\]\n$$",
    "`\\(inline code\\)`", "``line\n\\[code\\]``",
    "```text\n\\(code\\)\n```", "~~~text\n\\[code\\]\n~~~",
    "````text\n```\n\\[code\\]\n````", "~~~text\n```\n\\[code\\]\n~~~",
    "    \\(indented code\\)", "\t\\[indented code\\]",
    "> - ```text\n>   \\[nested code\\]\n>   ```",
    String.raw`[\(label\)](https://example.com/\(path\) "\[title\]")`,
    String.raw`![\(alt\)](picture.png)`, String.raw`<https://example.com/\(path\)>`,
    String.raw`https://example.com/\(path\)`,
    String.raw`[\(label\)][ref]` + "\n\n[ref]: https://example.com",
    String.raw`[ref]: https://example.com "\(title\)"`,
    String.raw`<code>\(literal\)</code>`, "<pre>\n\\[literal\\]\n</pre>",
    String.raw`\(before ` + "`code`" + String.raw` after\)`,
    String.raw`\[before [link](https://example.com) after\]`,
    String.raw`# \[x\]`,
    "| formula |\n| --- |\n| \\[x\\] |",
  ];

  it.each(untouched)("preserves native AST for protected or incomplete Markdown: %s", (input) => {
    expect(parser.parse(input)).toEqual(nativeParser.parse(input));
    expect(containsBackslashMath(input)).toBe(false);
  });

  it.each([
    [String.raw`高度 \(h=\dfrac{5b}{12}\)。`, [String.raw`h=\dfrac{5b}{12}`]],
    [String.raw`\(a*b*c\)\(x\ \)\[y\ \]`, ["a*b*c", "x\\ ", "y\\ "]],
    ["\\(x\n+y\\) 价格 $5\n\n后文", ["x\n+y"]],
    [String.raw`\(x\) and ` + "`\\(code\\)`" + String.raw` and [link](https://example.com/\(path\)) and \(y\)`, ["x", "y"]],
    [String.raw`- [ ] \[x\]`, ["x"]],
    ["-\t\\[x\\]", ["x"]],
    ["> \\[\n>x>0\n> \\]", ["x>0"]],
    ["- > \\(x\n  >y\\)", ["x\ny"]],
    ["\\[\r\nx+y\r\n\\]", ["x+y"]],
    ["\\[x\\\n\\]", ["x\\\n"]],
  ])("emits exact math values without rewriting source: %s", (input, expected) => {
    expect(mathValues(input)).toEqual(expected);
    expect(containsBackslashMath(input)).toBe(true);
  });

  it("does not pair delimiters across paragraphs or list items", () => {
    const input = "\\(first\n\nlast\\)\n\n- \\[first\n- last\\]";
    expect(parser.parse(input)).toEqual(nativeParser.parse(input));
    expect(containsBackslashMath(input)).toBe(false);
  });

  it("does not reuse allowed source ranges in a later parse", () => {
    for (let index = 0; index < 3; index += 1) {
      expect(mathValues(String.raw`\(x\)`)).toEqual(["x"]);
      expect(parser.parse(String.raw`\(not closed`)).toEqual(nativeParser.parse(String.raw`\(not closed`));
      expect(mathValues(String.raw`**结果 \[x=1\] 完成**`)).toEqual(["x=1"]);
    }
  });
});
