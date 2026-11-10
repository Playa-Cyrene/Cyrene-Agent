import remend, { type RemendOptions } from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";
import { getStreamingMathRanges, type StreamingMathRange } from "./streamdown-math";

// 外层只负责调用下面的完整原生补全，避免重复运行处理器或在恢复标记前提前返回。
const delegatedCompletion: RemendOptions = {
  links: false, images: false, bold: false, boldItalic: false, italic: false,
  comparisonOperators: false, htmlTags: false, inlineCode: false,
  inlineKatex: false, katex: false, setextHeadings: false, singleTilde: false, strikethrough: false,
};

/** 每个消息独立缓存当前块，避免对已经冻结的数学块反复做 AST 分析。 */
export function createMessageRemendOptions(): RemendOptions {
  let previous: { source: string; ranges: StreamingMathRange[]; stableEnd: number }[] = [];
  return {
    ...delegatedCompletion,
    handlers: [{
      name: "message-math-safe-completion",
      priority: 0,
      handle(input) {
        if (!input.includes("\\(") && !input.includes("\\[") && !input.includes("$")) {
          previous = [];
          return remend(input);
        }
        const text = input.replace(/\r\n?/g, "\n");
        const blocks = parseMarkdownIntoBlocks(text);
        const next = blocks.map((source, index) => {
          const old = previous[index];
          if (old?.source === source) return old;
          // 即使上游为 footnote 保留整篇单块，追加时也只分析最后一个活动顶层节点。
          const base = old && source.startsWith(old.source) ? old.stableEnd : 0;
          const active = getStreamingMathRanges(source.slice(base));
          return {
            source,
            stableEnd: base + active.stableEnd,
            ranges: [
              ...(old?.ranges.filter((range) => range.end <= base) ?? []),
              ...active.ranges.map((range) => ({ start: range.start + base, end: range.end + base })),
            ],
          };
        });
        previous = next;
        const ranges: StreamingMathRange[] = [];
        let offset = 0;
        for (const block of next) {
          for (const range of block.ranges) ranges.push({ start: range.start + offset, end: range.end + offset });
          offset += block.source.length;
        }
        // 临时标记只在补全调用内部存在，随后逐字恢复；不会送入 Markdown/KaTeX。
        // 先排除原文碰撞，且在原生补全提前返回后也必定执行恢复。
        let prefix = "\uE000";
        while (text.includes(prefix)) prefix += prefix;
        const tokens = new Map<string, string>();
        const mask = (value: string) => value.replace(/[\\`[\]()!<>$*_~]/g, (character) => {
          if (!tokens.has(character)) tokens.set(character, `${prefix}${tokens.size}\uE001`);
          return tokens.get(character)!;
        });
        let cursor = 0;
        let masked = "";
        for (const range of ranges) {
          if (range.end <= cursor) continue;
          masked += text.slice(cursor, Math.max(cursor, range.start));
          masked += mask(text.slice(Math.max(cursor, range.start), range.end));
          cursor = range.end;
        }
        masked += text.slice(cursor);
        let output = remend(masked);
        for (const [character, token] of tokens) output = output.replaceAll(token, character);
        return output;
      },
    }],
  };
}
