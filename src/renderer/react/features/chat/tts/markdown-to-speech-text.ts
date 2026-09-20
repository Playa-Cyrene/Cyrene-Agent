import { marked, type Token, type Tokens } from "marked";

export const SPEECH_TEXT_CONVERTER_VERSION = "markdown-v2";

export interface SpeechTextOptions {
  mode?: "default" | "learn";
  maxTableRows?: number;
  preferredAddress?: string;
}

export interface SpeechTextResult {
  text: string;
  warnings: string[];
  converterVersion: string;
}

const ORDINALS = ["第一项", "第二项", "第三项", "第四项", "第五项", "第六项", "第七项", "第八项", "第九项", "第十项"];
const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Shell",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  cpp: "C++",
  csharp: "C sharp",
  java: "Java",
  rust: "Rust",
  go: "Go",
};

function preferredAddress(options: SpeechTextOptions): string {
  return options.preferredAddress?.trim() || "伙伴";
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "小于")
    .replace(/&gt;/gi, "大于")
    .replace(/&quot;/gi, "引号")
    .replace(/&#39;|&apos;/gi, "单引号");
}

function spokenIdentifier(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isComplexLatex(latex: string): boolean {
  return /\\(?:int|sum|prod|lim|begin|matrix|cases|left|right|overline|underbrace)(?:\b|[_^{])/.test(latex)
    || latex.length > 90;
}

function latexToSpeech(latex: string): string {
  let result = latex.trim();
  result = result
    .replace(/\\int_\{([^{}]+)\}\^\{([^{}]+)\}/g, "从 $1 到 $2 的积分")
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$2 分之 $1")
    .replace(/\\sqrt\{([^{}]+)\}/g, "根号 $1")
    .replace(/([A-Za-z\d}])\^\{?2\}?/g, "$1 的平方")
    .replace(/([A-Za-z\d}])\^\{?3\}?/g, "$1 的立方")
    .replace(/([A-Za-z\d}])\^\{([^{}]+)\}/g, "$1 的 $2 次方")
    .replace(/([A-Za-z\d}])_\{?([^{}\s]+)\}?/g, "$1 下标 $2")
    .replace(/\\(?:mathrm|mathbf|text)\{([^{}]+)\}/g, "$1")
    .replace(/\\infty/g, "无穷")
    .replace(/\\pi/g, "派")
    .replace(/\\alpha/g, "阿尔法")
    .replace(/\\beta/g, "贝塔")
    .replace(/\\gamma/g, "伽马")
    .replace(/\\theta/g, "西塔")
    .replace(/\\lambda/g, "兰姆达")
    .replace(/\\Delta/g, "德尔塔")
    .replace(/\\int/g, "积分")
    .replace(/\\sum/g, "求和")
    .replace(/\\times|\\cdot/g, " 乘以 ")
    .replace(/\\div/g, " 除以 ")
    .replace(/\\pm/g, " 正负 ")
    .replace(/\\leq?|≤/g, " 小于等于 ")
    .replace(/\\geq?|≥/g, " 大于等于 ")
    .replace(/\\neq?|≠/g, " 不等于 ")
    .replace(/=/g, " 等于 ")
    .replace(/\+/g, " 加 ")
    .replace(/(?<![A-Za-z])-(?=\S)/g, "负 ")
    .replace(/\{/g, " ")
    .replace(/\}/g, " ")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/[\\$]/g, " ")
    .replace(/\b([A-Za-z])(?=[A-Za-z])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  return result;
}

function replaceMath(text: string, options: SpeechTextOptions, warnings: string[]): string {
  const convert = (_match: string, latex: string): string => {
    if (isComplexLatex(latex) && options.mode !== "learn") {
      addWarning(warnings, "complex-formula-skipped");
      return `${preferredAddress(options)}，请查看下面的公式`;
    }
    return latexToSpeech(latex);
  };
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, convert)
    .replace(/\\\[([\s\S]+?)\\\]/g, convert)
    .replace(/\$([^$\n]+?)\$/g, convert)
    .replace(/\\\((.+?)\\\)/g, convert);
}

function normalizeSpeechText(text: string): string {
  return text.replace(/♪/g, "。");
}

function sanitizePlainText(text: string, options: SpeechTextOptions, warnings: string[]): string {
  return normalizeSpeechText(replaceMath(decodeEntities(text), options, warnings))
    .replace(/https?:\/\/[^\s<>()]+/gi, "这里有一个链接")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s,，。；;]+\\?)+/g, "一个文件路径")
    .replace(/(?:^|\s)\/(?:[^/\s]+\/)+[^\s,，。；;]*/g, " 一个文件路径")
    .replace(/\b[a-f\d]{32,}\b/gi, "一个标识符")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从任意 token 安全取内联子 token：marked 的 Generic 变体（type 为宽 string，
 *  带 [key: string]: any 索引）无法被 switch 判别收窄，且各变体 tokens 字段
 *  可选性不一，统一收敛为非空列表。 */
function childTokens(token: Token): Token[] {
  const child = (token as { tokens?: Token[] }).tokens;
  return Array.isArray(child) ? child : [];
}

function inlineText(tokens: Token[], options: SpeechTextOptions, warnings: string[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "escape":
        return sanitizePlainText(token.text, options, warnings);
      case "text": {
        const inline = childTokens(token);
        return inline.length
          ? inlineText(inline, options, warnings)
          : sanitizePlainText(token.text, options, warnings);
      }
      case "strong":
      case "em":
      case "del":
        return inlineText(childTokens(token), options, warnings);
      case "codespan":
        return token.text.length <= 48 ? spokenIdentifier(token.text) : "一段行内代码";
      case "link": {
        const label = inlineText(childTokens(token), options, warnings);
        return /^https?:\/\//i.test(token.text) || !label ? "这里有一个链接" : label;
      }
      case "image": {
        const alt = sanitizePlainText(token.text, options, warnings);
        return alt ? `图片：${alt}` : "这里有一张图片";
      }
      case "br":
        return "，";
      case "html":
        return "";
      default: {
        const inline = childTokens(token);
        return inline.length ? inlineText(inline, options, warnings) : "";
      }
    }
  }).filter(Boolean).join("");
}

function stripTerminalPunctuation(text: string): string {
  return text.trim().replace(/[。！？；，、,.!?;:：]+$/g, "");
}

function sentence(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "";
  return /[。！？!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}

function tableText(token: Tokens.Table, options: SpeechTextOptions, warnings: string[]): string {
  const maxRows = Math.max(1, options.maxTableRows ?? 4);
  if (token.rows.length > maxRows) {
    addWarning(warnings, "large-table-skipped");
    return `${preferredAddress(options)}，请查看下面的表格。`;
  }
  const headers = token.header.map((cell) => stripTerminalPunctuation(inlineText(cell.tokens, options, warnings)));
  return token.rows.map((row, rowIndex) => {
    const values = row.map((cell, columnIndex) => {
      const value = stripTerminalPunctuation(inlineText(cell.tokens, options, warnings));
      const header = headers[columnIndex];
      return header ? `${header}是${value}` : value;
    }).filter(Boolean);
    const rowOrdinal = ["第一行", "第二行", "第三行", "第四行", "第五行"][rowIndex] ?? `第${rowIndex + 1}行`;
    return `${rowOrdinal}，${values.join("，")}。`;
  }).join(" ");
}

function blockText(tokens: Token[], options: SpeechTextOptions, warnings: string[]): string[] {
  const blocks: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
      case "paragraph":
        blocks.push(sentence(inlineText(childTokens(token), options, warnings)));
        break;
      case "text": {
        const inline = childTokens(token);
        blocks.push(sentence(inline.length
          ? inlineText(inline, options, warnings)
          : sanitizePlainText(token.text, options, warnings)));
        break;
      }
      case "blockquote": {
        const content = stripTerminalPunctuation(blockText(childTokens(token), options, warnings).join(" "));
        if (content) blocks.push(`引用内容：${content}。`);
        break;
      }
      // case 命中时联合里混有 Generic（type 为宽 string），cast 回具体类型取字段
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const content = stripTerminalPunctuation(blockText(item.tokens, options, warnings).join(" "));
          if (content) blocks.push(`${ORDINALS[index] ?? `第${index + 1}项`}，${content}。`);
        });
        break;
      }
      case "code": {
        const language = token.lang?.trim().split(/\s+/)[0].toLowerCase() ?? "";
        const label = LANGUAGE_NAMES[language] ?? (language ? spokenIdentifier(language) : "");
        blocks.push(`${preferredAddress(options)}，请查看下面的${label ? ` ${label} ` : ""}代码块。`);
        break;
      }
      case "table":
        blocks.push(tableText(token as Tokens.Table, options, warnings));
        break;
      case "html":
      case "space":
      case "hr":
      case "def":
        break;
      default: {
        const inline = childTokens(token);
        if (inline.length) blocks.push(...blockText(inline, options, warnings));
      }
    }
  }
  return blocks.filter(Boolean);
}

export function markdownToSpeechText(markdown: string, options: SpeechTextOptions = {}): SpeechTextResult {
  const warnings: string[] = [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown, { gfm: true, breaks: false });
  } catch {
    addWarning(warnings, "markdown-parse-failed");
    return {
      text: sentence(sanitizePlainText(markdown, options, warnings)),
      warnings,
      converterVersion: SPEECH_TEXT_CONVERTER_VERSION,
    };
  }
  return {
    text: blockText(tokens, options, warnings).join(" ").replace(/\s+/g, " ").trim(),
    warnings,
    converterVersion: SPEECH_TEXT_CONVERTER_VERSION,
  };
}
