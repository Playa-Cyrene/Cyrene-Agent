import { createMathPlugin } from "@streamdown/math";
import remarkParse from "remark-parse";
import { defaultRemarkPlugins } from "streamdown";
import { unified } from "unified";

export const messageMathPlugin = createMathPlugin({ singleDollarTextMath: true });
const parser = unified().use(remarkParse).use([defaultRemarkPlugins.gfm, messageMathPlugin.remarkPlugin]);

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface Edit { start: number; end: number; value: string }

const protectedTypes = new Set([
  "code", "inlineCode", "html", "link", "linkReference", "image", "imageReference",
  "definition", "math", "inlineMath",
]);

function escaped(input: string, index: number): boolean {
  let count = 0;
  while (index > 0 && input[--index] === "\\") count += 1;
  return count % 2 === 1;
}

/**
 * 只在 Markdown 正文的完整配对范围转换分隔符，原始消息不变。
 * 用解析器给出的源码范围保护代码、链接和现有公式；不能在整串文本上裸替换。
 */
export function normalizeBackslashMath(input: string): string {
  if (!input.includes("\\(") && !input.includes("\\[")) return input;
  const tree: MarkdownNode = parser.parse(input);
  const edits: Edit[] = [];

  function visit(node: MarkdownNode) {
    if (protectedTypes.has(node.type)) return;
    if (node.type !== "paragraph" && node.type !== "heading" && node.type !== "tableCell") {
      node.children?.forEach(visit);
      return;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const protectedRanges: [number, number][] = [];
    let hasHtml = false;
    function protect(child: MarkdownNode) {
      if (protectedTypes.has(child.type)) {
        hasHtml ||= child.type === "html";
        const from = child.position?.start.offset;
        const to = child.position?.end.offset;
        if (from !== undefined && to !== undefined) protectedRanges.push([from, to]);
      } else child.children?.forEach(protect);
    }
    node.children?.forEach(protect);
    // 行内 HTML 的成对标签可能包住正文；保守保留整段，避免改写 <code> 等内容。
    if (hasHtml) return;
    const overlaps = (from: number, to: number) => protectedRanges.some(([a, b]) => a < to && b > from);
    const unclosed = new Set<string>();

    for (let cursor = start; cursor < end - 1; cursor += 1) {
      if (input[cursor] !== "\\" || escaped(input, cursor) || overlaps(cursor, cursor + 2)) continue;
      const opener = input[cursor + 1];
      if ((opener !== "(" && opener !== "[") || unclosed.has(opener)) continue;
      const closer = opener === "(" ? ")" : "]";
      let close = cursor + 2;
      for (; close < end - 1; close += 1) {
        if (input[close] === "\\" && !escaped(input, close) && input[close + 1] === closer) break;
      }
      // 找不到闭合符时，本段后续同类开符也不可能闭合，避免重复扫描长流式片段。
      if (close >= end - 1) {
        unclosed.add(opener);
        continue;
      }
      const open = cursor;
      cursor = close + 1;
      if (overlaps(open, close + 2)) continue;
      let body = input.slice(open + 2, close);
      // 不把嵌套/混合分隔符或空公式猜成有效数学；未闭合流式片段也不补闭合符。
      if (!body.trim() || /\\[()[\]]/.test(body) || /(^|[^\\])\$/.test(body)) continue;
      if (opener === "(") {
        // Markdown 数学行内节点会把换行变空格；容器前缀由解析器正常处理。
        if (input[open - 1] === "$" || input[close + 2] === "$") continue;
        // remark-math 用分隔符长度配对，正文里的 \\$ 也会被看作单个美元序列。
        const delimiter = "$".repeat(Math.max(1, ...[...body.matchAll(/\$+/g)].map((match) => match[0].length + 1)));
        edits.push({ start: open, end: close + 2, value: `${delimiter}${body.trim()}${delimiter}` });
      } else {
        if (node.type === "tableCell" || node.type === "heading") continue;
        // 显示数学需要独立的 flow 节点；保留引用/列表的延续缩进，避免跳出嵌套容器。
        const lineStart = input.lastIndexOf("\n", start - 1) + 1;
        const sourcePrefix = input.slice(lineStart, start);
        const isTask = /\[[ xX]\][ \t]+$/.test(sourcePrefix);
        // 单独的任务公式变成 flow 后会使 GFM 丢失复选框；保留原文，而非破坏列表状态。
        if (isTask && open === start) continue;
        const prefix = sourcePrefix.replace(/\[[ xX]\][ \t]+$/, "").replace(/[^>\t ]/g, " ");
        body = body.split("\n").map((line, index) =>
          index > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line,
        ).join("\n").trim();
        const value = `\n${prefix}\n${prefix}$$\n${prefix}${body.replaceAll("\n", `\n${prefix}`)}\n${prefix}$$\n${prefix}\n${prefix}`;
        edits.push({ start: open, end: close + 2, value });
      }
    }
  }
  visit(tree);
  let output = input;
  for (const edit of edits.reverse()) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  return output;
}
