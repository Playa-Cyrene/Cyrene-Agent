import { createMathPlugin } from "@streamdown/math";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { InlineMath } from "mdast-util-math";
import type { Extension, State, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { defaultRemarkPlugins } from "streamdown";
import { unified, type Processor } from "unified";

const dollarMathPlugin = createMathPlugin({ singleDollarTextMath: true });
const protectionParser = unified().use(remarkParse).use([defaultRemarkPlugins.gfm, dollarMathPlugin.remarkPlugin]);

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface MathRange { end: number }

const protectedTypes = new Set([
  "code", "inlineCode", "html", "link", "linkReference", "image", "imageReference",
  "definition", "math", "inlineMath",
]);

function escaped(input: string, index: number): boolean {
  let count = 0;
  while (index > 0 && input[--index] === "\\") count += 1;
  return count % 2 === 1;
}

function hasNestedMathDelimiter(
  input: string, start: number, end: number, overlaps: (from: number, to: number) => boolean,
): boolean {
  let opener: string | undefined;
  for (const match of input.slice(start, end).matchAll(/\\[()[\]]/g)) {
    const index = start + match.index;
    // TeX 的 \\[4pt] 是换行间距参数，代码/链接中的伪标记也不参与配对。
    if (escaped(input, index) || overlaps(index, index + 2)) continue;
    const delimiter = match[0][1];
    if (delimiter === "(" || delimiter === "[") {
      if (opener) return true;
      opener = delimiter;
    } else if (opener) {
      if (delimiter !== (opener === "(" ? ")" : "]")) return true;
      opener = undefined;
    }
  }
  return false;
}

/** 原生解析只决定可转换的源码范围，不重写美元、空白或 Markdown 块边界。 */
function findBackslashMath(input: string, tree: MarkdownNode, includeUnclosed = false): Map<number, MathRange> {
  const ranges = new Map<number, MathRange>();
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
    // HTML 标签可能包住正文，保守保留整段（包括 <code> 内的示例）。
    if (hasHtml) return;
    const overlaps = (from: number, to: number) => protectedRanges.some(([a, b]) => a < to && b > from);
    // 有歧义的容器整体保留，不能拒绝第一组后继续渲染后面的内层公式。
    if (hasNestedMathDelimiter(input, start, end, overlaps)) {
      if (includeUnclosed) ranges.set(start, { end });
      return;
    }
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
      // 未闭合流式片段保持原文，同类开符不再重复扫描。
      if (close >= end - 1) {
        if (includeUnclosed) ranges.set(cursor, { end });
        unclosed.add(opener);
        continue;
      }
      const open = cursor;
      cursor = close + 1;
      if (overlaps(open, close + 2)) continue;
      const body = input.slice(open + 2, close);
      if (!body.trim() || /(^|[^\\])\$/.test(body)) continue;
      if (opener === "[" && (node.type === "tableCell" || node.type === "heading")) continue;
      ranges.set(open, { end: close + 2 });
    }
  }
  visit(tree);
  return ranges;
}

export function containsBackslashMath(input: string): boolean {
  return (input.includes("\\(") || input.includes("\\[")) &&
    findBackslashMath(input, protectionParser.parse(input)).size > 0;
}

export interface StreamingMathRange { start: number; end: number }

/** 只供补全阶段分析当前变化的块；冻结块的范围由调用方缓存。 */
export function getStreamingMathRanges(input: string): { ranges: StreamingMathRange[]; stableEnd: number } {
  if (!input.includes("\\(") && !input.includes("\\[") && !input.includes("$")) return { ranges: [], stableEnd: 0 };
  const tree = protectionParser.parse(input);
  const ranges = [...findBackslashMath(input, tree, true)]
    .map(([start, range]) => ({ start, end: range.end }));
  function visit(node: MarkdownNode) {
    if (node.type === "math" || node.type === "inlineMath") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else node.children?.forEach(visit);
  }
  visit(tree);
  // footnote 等消息在 Streamdown 中是单块；仍可冻结最后一个顶层节点之前的范围。
  const stableEnd = tree.children.at(-1)?.position?.start.offset ?? 0;
  return { ranges: ranges.sort((a, b) => a.start - b.start), stableEnd };
}

export function analyzeCompletedMarkdown(input: string): { hasMath: boolean; hasReferences: boolean } {
  if (!input.includes("\\(") && !input.includes("\\[") && !input.includes("$")) {
    return { hasMath: false, hasReferences: false };
  }
  const tree = protectionParser.parse(input);
  let hasMath = findBackslashMath(input, tree).size > 0;
  let hasReferences = false;
  function visit(node: MarkdownNode) {
    hasMath ||= node.type === "math" || node.type === "inlineMath";
    hasReferences ||= node.type === "linkReference" || node.type === "imageReference";
    node.children?.forEach(visit);
  }
  visit(tree);
  return { hasMath, hasReferences };
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    cyreneBackslashMath: "cyreneBackslashMath";
    cyreneBackslashMathData: "cyreneBackslashMathData";
  }
}

/**
 * 在字符转义/强调解析前消费完整公式，直接输出 KaTeX 认识的数学节点。
 * 使用 text token 保留 strong/emphasis/delete 等容器，显示语义由 math-display 提供；
 * 不提升为 flow 节点，避免拆段、丢任务复选框或吞掉后文。
 */
function remarkBackslashMath(this: Processor) {
  const nativeParse = this.parser!;
  let ranges = new Map<number, MathRange>();
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const context = this;
    const range = ranges.get(context.now().offset);
    if (!range) return nok;
    let inData = false;
    const consume: State = (code) => {
      if (context.now().offset === range.end) {
        if (inData) effects.exit("cyreneBackslashMathData");
        effects.exit("cyreneBackslashMath");
        return ok(code);
      }
      if (code === null) return nok(code);
      const lineEnding = code === -5 || code === -4 || code === -3;
      if (lineEnding) {
        if (inData) effects.exit("cyreneBackslashMathData");
        inData = false;
        effects.enter("lineEnding");
      } else if (!inData) {
        effects.enter("cyreneBackslashMathData");
        inData = true;
      }
      effects.consume(code);
      if (lineEnding) effects.exit("lineEnding");
      return consume;
    };
    return (code) => {
      effects.enter("cyreneBackslashMath");
      return consume(code);
    };
  };
  const syntax: Extension = { text: { 92: { name: "cyreneBackslashMath", tokenize } } };
  const fromMarkdown: FromMarkdownExtension = {
    enter: {
      cyreneBackslashMath(token) {
        const raw = this.sliceSerialize(token);
        const display = raw[1] === "[";
        // 仅去掉显示分隔符独占行造成的首尾换行，不能 trim 掉 TeX 控制空格。
        let value = raw.slice(2, -2).replace(/\r\n?/g, "\n");
        if (display) {
          value = value.replace(/^[ \t]*\n/, "");
          const trailingLine = /\n[ \t]*$/.exec(value);
          if (trailingLine && !escaped(value, trailingLine.index)) value = value.slice(0, trailingLine.index);
        }
        const node: InlineMath = {
          type: "inlineMath",
          value,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", display ? "math-display" : "math-inline"] },
            hChildren: [{ type: "text", value }],
          },
        };
        this.enter(node, token);
      },
    },
    exit: { cyreneBackslashMath(token) { this.exit(token); } },
  };
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
  this.parser = (input, file) => {
    // 第一遍让原生插件标记链接、代码、HTML、美元数学和容器边界。
    // 第二遍只允许已验证的范围进入 tokenizer；每次 parse 均清空，不能泄漏到下一块。
    ranges = new Map();
    const tree = nativeParse(input, file);
    if (!input.includes("\\(") && !input.includes("\\[")) return tree;
    ranges = findBackslashMath(input, tree);
    if (!ranges.size) return tree;
    try {
      return nativeParse(input, file);
    } finally {
      ranges = new Map();
    }
  };
}

function remarkMessageMath(this: Processor) {
  this.use([dollarMathPlugin.remarkPlugin]).use(remarkBackslashMath);
}

export const messageMathPlugin = { ...dollarMathPlugin, remarkPlugin: remarkMessageMath };
