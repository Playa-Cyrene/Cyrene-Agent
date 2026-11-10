import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import { defaultRemarkPlugins } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { unified } from "unified";
import { containsBackslashMath, messageMathPlugin } from "./streamdown-math";

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
  const untouched = [
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
    [String.raw`\[incomplete but \(x\)`, ["x"]],
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
