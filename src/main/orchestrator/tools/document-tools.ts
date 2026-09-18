// 文档生成工具 —— 让昔涟能产出可交付物（Excel/Word/PDF）。
// Markdown/纯文本笔记统一走 write_file（见 fs-tools.ts）。
//
// 设计要点：
// - 绑定项目时文档存到该项目根目录；未绑定时才回退到桌面
// - 支持桌面子目录（如 "test/report.xlsx"），自动创建父目录
// - 文件名由模型给，强制校验扩展名（防 .exe 等危险后缀）
// - 返回完整路径给模型，模型可以转述给用户
// - PDF 中文字体走系统微软雅黑（Windows），找不到就降级

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { findSkillPath } from "../../external-content-paths";
import { getRunReviewTracker } from "../review/run-review-tracker";

const LOG_PREFIX = "[DocTools]";

/** 校验文件名：必须有合法扩展名，不能有危险字符。ext 支持多个候选（如 [".md", ".txt"]）。 */
function validateFilename(filename: string, ext: string | string[]): string | null {
  if (!filename || typeof filename !== "string") return null;
  const exts = Array.isArray(ext) ? ext : [ext];
  if (!exts.some((e) => filename.toLowerCase().endsWith(e))) return null;
  // 防危险字符
  if (/[<>:"|?*]/.test(filename)) return null;
  return filename;
}

/**
 * filename 校验失败报错：区分「未提供」与「值不合法」，并回传实际收到的参数键。
 * 丢参模型（如缺 filename 只传了 content）拿到点名报错才能自纠，
 * 否则只会看到"必须是 .md 结尾"而意识不到自己根本没传。
 */
function filenameError(ext: string, args: Record<string, unknown>): string {
  const raw = args.filename;
  const keys = Object.keys(args).join(", ") || "（空）";
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return `[错误] 未提供 filename 参数（要求 ${ext} 结尾）。本次收到的参数键：${keys}。请补上 filename 后重试。`;
  }
  const value = String(raw);
  if (/[<>:"|?*]/.test(value)) {
    return `[错误] filename 含非法字符（<>:"|?*）：${value}`;
  }
  return `[错误] filename 必须是 ${ext} 结尾，实际收到：${value}。`;
}

/** 写盘前捕获 Review 基线（runId 存在时；二进制文件 tracker 只存 metadata）。 */
function captureBaseline(context: ToolContext | undefined, outputPath: string): void {
  if (!context?.runId) return;
  const tracker = getRunReviewTracker(app.getPath("userData"));
  tracker.captureBefore(context.runId, outputPath);
}

/**
 * 解析输出路径：filename 可含子目录（如 "test/report.xlsx"）。
 * 有可信工作区绑定时根目录固定为工作区；否则兼容旧行为写入桌面。
 * 安全校验：禁止 .. 穿越、禁止绝对路径（不能写到桌面之外）。
 * 返回绝对路径，或 null 表示校验失败。
 */
function resolveOutputPath(filename: string, workspaceRoot?: string): string | null {
  const normalized = path.normalize(filename).replace(/\\/g, "/");
  // 禁止目录穿越和绝对路径
  if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
  const outputRoot = path.resolve(workspaceRoot || app.getPath("desktop"));
  const fullPath = path.resolve(outputRoot, normalized);
  const relative = path.relative(outputRoot, fullPath);
  // 最终校验：必须仍在可信工作区/桌面根目录下，不能靠前缀碰撞绕过。
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return fullPath;
}

// ── 样式加载器（Excel + Word 共用）──
// 从 skills/{skillId}/styles/ 目录加载 json 风格文件，带缓存。
interface StyleCacheEntry { [styleId: string]: Record<string, unknown> }
const styleCache = new Map<string, StyleCacheEntry>();
const styleLoaded = new Set<string>();

function loadStylesDir(skillId: string): StyleCacheEntry {
  if (styleLoaded.has(skillId)) return styleCache.get(skillId) ?? {};
  styleLoaded.add(skillId);
  const cache: StyleCacheEntry = {};
  try {
    const stylesDir = findSkillPath(skillId, "styles");
    if (!stylesDir) return {};

    for (const f of fs.readdirSync(stylesDir)) {
      if (!f.endsWith(".json")) continue;
      const styleId = f.replace(/\.json$/, "");
      try {
        cache[styleId] = JSON.parse(fs.readFileSync(path.join(stylesDir, f), "utf8"));
      } catch { /* 跳过坏文件 */ }
    }
    console.log(LOG_PREFIX, `已加载 ${skillId} 样式:`, Object.keys(cache).join(", ") || "(无)");
  } catch { /* 目录不存在 */ }
  styleCache.set(skillId, cache);
  return cache;
}

/** 把 hex 颜色转成 ARGB（FF 前缀），docx 库用 6 位 RRGGBB 不带 FF 前缀。 */
function toHexColor(color: string): string {
  const c = color.replace("#", "").toUpperCase();
  if (c.length === 8) return c.slice(2);  // FFRRGGBB → RRGGBB
  if (c.length === 6) return c;
  return "1F4E79"; // 兜底
}

export function registerDocumentTools(): void {
  // ── 样式系统 ──
  // 从 skills/xlsx/styles/ 目录加载预设风格 json，取代硬编码。
  // 模型弹卡片前读 catalog.md 选风格，用户选完传 style 名给 write_excel。
  type ExcelFill = import("exceljs").Fill;
  type ExcelBorders = import("exceljs").Borders;

  interface Theme {
    name: string;
    headerFill: string;      // ARGB
    headerFont: string;     // ARGB
    headerBorder: string;   // ARGB (medium bottom)
    zebraFill: string;      // ARGB
    borderColor: string;    // ARGB
  }

  /** 从 skills/xlsx/styles/ 加载所有风格 json（带缓存）。 */
  const themeCache = new Map<string, Theme>();
  let themesLoaded = false;

  const DEFAULT_THEME: Theme = {
    name: "默认深蓝", headerFill: "FF1F4E79", headerFont: "FFFFFFFF",
    headerBorder: "FF1F4E79", zebraFill: "FFF2F2F2", borderColor: "FFBFBFBF",
  };

  function loadThemes(): void {
    if (themesLoaded) return;
    themesLoaded = true;
    try {
      const stylesDir = findSkillPath("xlsx", "styles");
      if (!stylesDir) return;

      for (const f of fs.readdirSync(stylesDir)) {
        if (!f.endsWith(".json")) continue;
        const styleId = f.replace(/\.json$/, "");
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(stylesDir, f), "utf8"));
          themeCache.set(styleId, {
            name: String(raw.name || styleId),
            headerFill: String(raw.headerFill || DEFAULT_THEME.headerFill),
            headerFont: String(raw.headerFont || DEFAULT_THEME.headerFont),
            headerBorder: String(raw.headerBorder || DEFAULT_THEME.headerBorder),
            zebraFill: String(raw.zebraFill || DEFAULT_THEME.zebraFill),
            borderColor: String(raw.borderColor || DEFAULT_THEME.borderColor),
          });
        } catch { /* 跳过坏文件 */ }
      }
      console.log(LOG_PREFIX, "已加载样式:", Array.from(themeCache.keys()).join(", ") || "(无)");
    } catch {
      // 目录不存在，用默认主题
    }
  }

  function getTheme(style?: string): Theme {
    loadThemes();
    if (!style) return themeCache.get("default") ?? DEFAULT_THEME;
    return themeCache.get(style) ?? themeCache.get("default") ?? DEFAULT_THEME;
  }

  /** 把 hex 颜色 (#RRGGBB 或 RRGGBB) 转成 ARGB (FFRRGGBB)，已含 FF 前缀则原样返回。 */
  function toArgb(color: string): string {
    const c = color.replace("#", "").toUpperCase();
    if (c.length === 8) return c;
    if (c.length === 6) return "FF" + c;
    return "FF1F4E79"; // 兜底
  }

  /**
   * 用自定义颜色覆盖主题。colors 里每个字段是可选的 ARGB hex 值。
   * 模型能把用户自然语言（"粉色""深灰"）翻译成 hex 后传进来。
   */
  function mergeTheme(base: Theme, colors?: {
    headerFill?: string; headerFont?: string; headerBorder?: string;
    zebraFill?: string; borderColor?: string;
  }): Theme {
    if (!colors) return base;
    return {
      name: base.name + "(自定义)",
      headerFill: colors.headerFill ? toArgb(colors.headerFill) : base.headerFill,
      headerFont: colors.headerFont ? toArgb(colors.headerFont) : base.headerFont,
      headerBorder: colors.headerBorder ? toArgb(colors.headerBorder) : base.headerBorder,
      zebraFill: colors.zebraFill ? toArgb(colors.zebraFill) : base.zebraFill,
      borderColor: colors.borderColor ? toArgb(colors.borderColor) : base.borderColor,
    };
  }

  // ── write_excel ──────────────────────────────────────
  toolRegistry.register({
    id: "write_excel",
    name: "写 Excel",
    description:
      "生成一个美观的 Excel 文件（.xlsx）。支持多种预设风格 + 自定义颜色。已内置：表头加粗+背景、" +
      "全表细边框、隔行斑马纹、列宽自适应、数字右对齐+千位分隔、冻结首行、自动筛选。\n" +
      "【优先使用】简单表格生成、数据整理、换算结果导出等场景应直接用此工具，不要走 invoke_skill(xlsx)。\n\n" +
      "何时用：\n" +
      "- 用户要把数据整理成表格\n" +
      "- 用户要「做一张表」「导出 Excel」「整理成 Excel」\n" +
      "- 用户通过 ask_user_choice 选择了风格 → 用对应 style 参数直接生成\n" +
      "- 用户给了自定义颜色要求 → 用 colors 参数传 ARGB hex 值\n\n" +
      "不要用于：\n" +
      "- 需要 Excel 公式、编辑已有 xlsx → 才考虑 invoke_skill(xlsx)\n\n" +
      "style：预设风格名（见 skills/xlsx/styles/catalog.md）。可选值含 default / dark / colorful / simple-business / financial。\n" +
      "colors（可选）：自定义颜色覆盖，每个是 ARGB hex 如 'FFF8BBD0'（粉色）。\n" +
      "参数：filename（.xlsx 结尾，可含子目录），sheets（工作表数组），style（可选），colors（可选）。",
    enabled: true,
    risk: "fs-write",
    modes: ["work"],
    needsContext: true,
    effectKind: "mutation" as const,
    verificationPolicy: "artifact" as const,
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，可含子目录如 'test/report.xlsx'（相对桌面，.xlsx 结尾）" },
        sheets: {
          type: "array",
          description: "工作表数组",
          items: {
            type: "object",
            properties: {
              name:    { type: "string", description: "工作表名" },
              headers: { type: "array", description: "表头字符串数组", items: { type: "string" } },
              rows:    { type: "array", description: "数据行，每行是一个数组", items: { type: "string" } },
            },
          },
        },
        style: { type: "string", description: "预设主题：default(深蓝,默认) / simple-business(简洁商务) / dark(深色护眼) / colorful(彩色清晰) / financial(财务报表)" },
        colors: {
          type: "object",
          description: "自定义颜色覆盖（ARGB hex，如 'FFF8BBD0' 粉色 / 'FF2D2D2D' 深灰）。你负责把用户的颜色描述翻译成 hex。",
          properties: {
            headerFill: { type: "string", description: "表头背景色 ARGB hex，如 'FFF8BBD0'(粉)" },
            headerFont: { type: "string", description: "表头文字色 ARGB hex，如 'FF333333'(深灰)" },
            headerBorder: { type: "string", description: "表头底线色 ARGB hex" },
            zebraFill: { type: "string", description: "斑马纹背景色 ARGB hex" },
            borderColor: { type: "string", description: "边框颜色 ARGB hex" },
          },
        },
      },
      required: ["filename", "sheets"],
    },
    execute: async (args, context?: ToolContext) => {
      const filename = validateFilename(String(args.filename || ""), ".xlsx");
      if (!filename) return filenameError(".xlsx", args);
      const outputPath = resolveOutputPath(filename, context?.resolvedWorkspaceRoot);
      if (!outputPath) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename;
      const sheets = args.sheets as Array<{
        name: string; headers: string[]; rows: unknown[][];
      }>;
      if (!Array.isArray(sheets) || sheets.length === 0) {
        return "[错误] sheets 不能为空。本次收到的参数键：" + (Object.keys(args).join(", ") || "（空）");
      }

      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();

      // 选主题（预设 + 自定义颜色覆盖）
      const baseTheme = getTheme(args.style ? String(args.style) : undefined);
      const colors = args.colors as {
        headerFill?: string; headerFont?: string; headerBorder?: string;
        zebraFill?: string; borderColor?: string;
      } | undefined;
      const theme = mergeTheme(baseTheme, colors);
      console.log(LOG_PREFIX, "Excel 主题:", theme.name, "style=" + (args.style || "default"), colors ? "+自定义颜色" : "");

      const HEADER_FILL: ExcelFill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerFill } };
      const ZEBRA_FILL: ExcelFill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.zebraFill } };
      const THIN_BORDER: Partial<ExcelBorders> = {
        top: { style: "thin", color: { argb: theme.borderColor } },
        left: { style: "thin", color: { argb: theme.borderColor } },
        bottom: { style: "thin", color: { argb: theme.borderColor } },
        right: { style: "thin", color: { argb: theme.borderColor } },
      };
      const HEADER_BOTTOM_BORDER: Partial<ExcelBorders> = {
        ...THIN_BORDER,
        bottom: { style: "medium", color: { argb: theme.headerBorder } },
      };

      for (const s of sheets) {
        const ws = workbook.addWorksheet(s.name || "Sheet1");

        // 写入数据
        if (Array.isArray(s.headers)) ws.addRow(s.headers);
        for (const row of (s.rows || [])) ws.addRow(row);

        const headers = s.headers || [];
        const dataRowCount = (s.rows?.length || 0);
        const totalRows = dataRowCount + 1; // +1 for header

        // 1. 表头样式：白粗体字 + 深蓝填充 + 居中 + 底部粗线
        // 逐 cell 设置（行级 fill/font/alignment 会铺到无值的空列，导致表头蓝条超出实际列数）
        const headerRow = ws.getRow(1);
        headerRow.height = 24;
        headerRow.eachCell({ includeEmpty: false }, (cell) => {
          cell.font = { bold: true, color: { argb: theme.headerFont }, size: 11, name: "Calibri" };
          cell.fill = HEADER_FILL;
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = HEADER_BOTTOM_BORDER;
        });

        // 2. 数据行：全表细边框 + 智能数字格式 + 斑马纹
        for (let r = 2; r <= totalRows; r++) {
          const row = ws.getRow(r);
          // 斑马纹（偶数数据行 = Excel 标准交替灰）
          const isZebra = (r - 1) % 2 === 0;
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            cell.border = THIN_BORDER;
            // 斑马纹需逐 cell 设（行级 fill 会被 eachCell 的 cell 对象覆盖）
            if (isZebra) {
              cell.fill = ZEBRA_FILL;
            }
            // 智能数字格式（参考 minimax skill format.md 的格式矩阵）
            if (typeof cell.value === "number") {
              cell.alignment = { horizontal: "right", vertical: "middle" };
              // 按列内容推断数字格式
              const headerText = headers[colNumber - 1] ? String(headers[colNumber - 1]).toLowerCase() : "";
              if (/年|year/.test(headerText)) {
                cell.numFmt = "0";              // 年份：无千位分隔（2024 不是 2,024）
              } else if (/%|率|比|ratio|rate|涨|跌|幅/.test(headerText)) {
                cell.numFmt = "0.0%";           // 百分比
              } else if (/\$|元|价|额|金|amount|price|cost|revenue/.test(headerText)) {
                cell.numFmt = "#,##0.00";      // 货币：带分
              } else if (Number.isInteger(cell.value) && Math.abs(cell.value) >= 1000) {
                cell.numFmt = "#,##0";          // 大整数：千位分隔无小数
              } else {
                cell.numFmt = "#,##0.00";       // 默认数字
              }
            } else if (cell.value instanceof Date) {
              cell.alignment = { horizontal: "center", vertical: "middle" };
              cell.numFmt = "yyyy-mm-dd";
            } else {
              cell.alignment = { horizontal: "left", vertical: "middle" };
            }
          });
        }

        // 3. 列宽自适应：按表头 + 数据行中最大宽度计算（中文按 2 宽度估算）
        ws.columns.forEach((col, i) => {
          let maxLen = headers[i] ? Array.from(String(headers[i])).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0) + 4 : 8;
          for (const row of (s.rows || [])) {
            const val = row[i];
            if (val !== undefined && val !== null) {
              const len = Array.from(String(val)).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
              if (len + 2 > maxLen) maxLen = len + 2;
            }
          }
          col.width = Math.min(Math.max(maxLen, 10), 45);
        });

        // 4. 冻结首行
        ws.views = [{ state: "frozen", ySplit: 1 }];

        // 5. 自动筛选：表头行加 filter（方便用户筛选排序）
        if (headers.length > 0 && dataRowCount > 0) {
          ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: totalRows, column: headers.length },
          };
        }
      }

      // 自动创建父目录（支持子目录写入）
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      captureBaseline(context, outputPath);
      await workbook.xlsx.writeFile(outputPath);
      console.log(LOG_PREFIX, "Excel 已生成（默认美观样式）:", outputPath);
      return `[write_excel] 已生成：${outputPath}`;
    },
  });

  // ── write_word ───────────────────────────────────────
  toolRegistry.register({
    id: "write_word",
    name: "写 Word",
    description:
      "生成一个美观的 Word 文档（.docx）。支持多种预设风格主题。\n" +
      "已内置：标题样式（颜色/字号/字体）、正文行距/字体/颜色、段落间距。\n\n" +
      "何时用：\n" +
      "- 用户要写报告/总结/方案/请假条\n" +
      "- 需要「导出成 Word」「做成 docx」\n" +
      "- 用户通过 ask_user_choice 选择了风格 → 用对应 style 参数直接生成\n\n" +
      "不要用于：\n" +
      "- 表格数据（用 write_excel）\n" +
      "- 轻量笔记（用 write_file）\n" +
      "- 需要复杂排版（页眉页脚/目录/图片/表格）→ 才考虑 invoke_skill(docx)\n\n" +
      "style 可选值（见 skills/docx/styles/catalog.md）：default(商务) / academic(学术) / clean(极简) / elegant(优雅) / formal(公文)。\n" +
      "参数：filename（只传文件名，如 AI新闻汇总.docx，不要传绝对路径；输出目录由系统固定为桌面），title（标题），paragraphs（段落数组），style（可选预设风格）。",
    enabled: true,
    risk: "fs-write",
    modes: ["work"],
    needsContext: true,
    effectKind: "mutation" as const,
    verificationPolicy: "artifact" as const,
    inputSchema: {
      type: "object",
      properties: {
        filename:   { type: "string", description: "文件名，必须以 .docx 结尾，例如 'AI新闻汇总.docx'。只传文件名，不要传绝对路径或目录。文件默认写入系统指定的桌面目录。" },
        title:      { type: "string", description: "文档标题" },
        paragraphs: { type: "array", description: "段落字符串数组", items: { type: "string" } },
        style:      { type: "string", description: "预设风格：default(商务) / academic(学术) / clean(极简) / elegant(优雅) / formal(公文)" },
      },
      required: ["filename", "title", "paragraphs"],
    },
    execute: async (args, context?: ToolContext) => {
      const filename = validateFilename(String(args.filename || ""), ".docx");
      if (!filename) return filenameError(".docx", args);
      const outputPath = resolveOutputPath(filename, context?.resolvedWorkspaceRoot);
      if (!outputPath) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename;

      // 加载风格
      const styles = loadStylesDir("docx");
      const styleId = args.style ? String(args.style) : "default";
      const theme = (styles[styleId] ?? styles["default"]) as {
        name?: string; titleColor?: string; titleSize?: number; titleFont?: string;
        bodyFont?: string; bodySize?: number; bodyColor?: string; lineSpacing?: number; headingColor?: string;
      } | undefined;

      const titleColor = toHexColor(theme?.titleColor ?? "FF1F4E79");
      const titleSize = theme?.titleSize ?? 28;
      const titleFont = theme?.titleFont ?? "微软雅黑";
      const bodyFont = theme?.bodyFont ?? "微软雅黑";
      const bodySize = theme?.bodySize ?? 24;
      const bodyColor = toHexColor(theme?.bodyColor ?? "FF333333");
      const lineSpacing = theme?.lineSpacing ?? 360;
      const headingColor = toHexColor(theme?.headingColor ?? "FF1F4E79");

      console.log(LOG_PREFIX, "Word 主题:", theme?.name ?? "默认商务", "style=" + styleId);

      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
      const doc = new Document({
        styles: {
          default: {
            document: {
              run: { font: bodyFont, size: bodySize, color: bodyColor },
              paragraph: { spacing: { line: lineSpacing } },
            },
          },
        },
        sections: [{
          children: [
            new Paragraph({
              text: String(args.title || ""),
              heading: HeadingLevel.HEADING_1,
              run: { font: titleFont, size: titleSize, bold: true, color: titleColor },
              spacing: { after: 200, line: lineSpacing },
            }),
            ...((args.paragraphs as string[]) || []).map(p =>
              new Paragraph({
                children: [new TextRun({ text: p, font: bodyFont, size: bodySize, color: bodyColor })],
                spacing: { line: lineSpacing, after: 120 },
              })
            ),
          ],
        }],
      });

      const buffer = await Packer.toBuffer(doc);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      captureBaseline(context, outputPath);
      fs.writeFileSync(outputPath, buffer);
      console.log(LOG_PREFIX, "Word 已生成:", outputPath);
      return `[write_word] 已生成：${outputPath}`;
    },
  });

  // ── write_pdf ────────────────────────────────────────
  toolRegistry.register({
    id: "write_pdf",
    name: "写 PDF",
    description:
      "生成一个 PDF 文件保存到桌面。\n\n" +
      "何时用：\n" +
      "- 用户要写正式文档（合同/简历/申请书）\n" +
      "- 需要「导出成 PDF」\n\n" +
      "不要用于：\n" +
      "- 可编辑文档（用 write_word）\n" +
      "- 表格数据（用 write_excel）\n\n" +
      "参数：filename（.pdf 结尾），title（标题），paragraphs（段落数组）。",
    enabled: true,
    risk: "fs-write",
    modes: ["work"],
    needsContext: true,
    effectKind: "mutation" as const,
    verificationPolicy: "artifact" as const,
    inputSchema: {
      type: "object",
      properties: {
        filename:   { type: "string", description: "文件名（.pdf 结尾）" },
        title:      { type: "string", description: "标题" },
        paragraphs: { type: "array", description: "段落字符串数组", items: { type: "string" } },
      },
      required: ["filename", "title", "paragraphs"],
    },
    execute: async (args, context?: ToolContext) => {
      const filename = validateFilename(String(args.filename || ""), ".pdf");
      if (!filename) return filenameError(".pdf", args);
      const outputPath = resolveOutputPath(filename, context?.resolvedWorkspaceRoot);
      if (!outputPath) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename;

      const PDFKit = await import("pdfkit");
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      captureBaseline(context, outputPath);
      const doc = new PDFKit.default();
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // 中文字体：Windows 用微软雅黑，找不到则用默认（中文会乱码但能生成）
      const fontCandidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "C:\\Windows\\Fonts\\simhei.ttf",
      ];
      for (const f of fontCandidates) {
        if (fs.existsSync(f)) { doc.font(f); break; }
      }

      doc.fontSize(22).text(String(args.title || ""), { align: "center" });
      doc.moveDown();
      doc.fontSize(12);
      for (const p of (args.paragraphs as string[]) || []) {
        doc.text(p, { align: "left" });
        doc.moveDown(0.5);
      }
      doc.end();

      await new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
      });
      console.log(LOG_PREFIX, "PDF 已生成:", outputPath);
      return `[write_pdf] 已生成：${outputPath}`;
    },
  });
}
