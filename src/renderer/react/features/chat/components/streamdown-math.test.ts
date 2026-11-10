import { describe, expect, it } from "vitest";
import { normalizeBackslashMath } from "./streamdown-math";

describe("normalizeBackslashMath", () => {
  it("normalizes complete inline math without changing TeX", () => {
    expect(normalizeBackslashMath(String.raw`高度 \(h=\dfrac{5b}{12}\)。`))
      .toBe(String.raw`高度 $h=\dfrac{5b}{12}$。`);
  });

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
    String.raw`- [ ] \[x\]`,
    String.raw`# \[x\]`,
    "| formula |\n| --- |\n| \\[x\\] |",
  ];
  it.each(untouched)("preserves protected or incomplete Markdown: %s", (input) => {
    expect(normalizeBackslashMath(input)).toBe(input);
  });

  it("only changes math outside protected code and links", () => {
    const input = String.raw`\(x\) and ` + "`\\(code\\)`" + String.raw` and [link](https://example.com/\(path\)) and \(y\)`;
    expect(normalizeBackslashMath(input)).toBe(String.raw`$x$ and ` + "`\\(code\\)`" + String.raw` and [link](https://example.com/\(path\)) and $y$`);
  });

  it("does not pair delimiters across paragraphs or list items", () => {
    const input = "\\(first\n\nlast\\)\n\n- \\[first\n- last\\]";
    expect(normalizeBackslashMath(input)).toBe(input);
  });

  it("still renders a complete other kind of math after an unclosed delimiter", () => {
    expect(normalizeBackslashMath(String.raw`\[incomplete but \(x\)`)).toBe(String.raw`\[incomplete but $x$`);
  });

  it.each([
    String.raw`\(x\) \[y\]`,
    "> - before \\[\n>   x^2 + y^2\n>   \\] after",
    "1. \\[x\\]",
    "| formula |\n| --- |\n| \\(x\\) |",
    ...untouched,
  ])("is idempotent: %s", (input) => {
    const normalized = normalizeBackslashMath(input);
    expect(normalizeBackslashMath(normalized)).toBe(normalized);
  });
});
