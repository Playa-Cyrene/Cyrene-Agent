// ── Office 结构化文档正文抽取（进程内、无需视觉模型）────────────────
//
// 本模块只负责把「结构化但可程序化解析」的文档转成纯文本，供两处复用：
//   1) read_file / Read：用户直接要「看某个 Word/Excel 写了什么」时读全文；
//   2) find_files 的 searchContent：搜索时读进候选文件内容做关键词匹配。
//
// 文件可读性分级（与 find_files / read_file 工具描述保持一致）：
//   L1 纯文本/代码：readFileSync 直读，不在本模块范围。
//   L2 结构化文档（本模块处理，全部进程内、无模型）：
//        .docx        → ZIP，解出 word/document.xml 剥 XML 标签取正文（用直接依赖 extract-zip）
//        .xlsx/.xlsm  → exceljs 遍历单元格取文本
//   L3a 图片（需视觉模型）：png/jpg/jpeg/gif/webp/bmp/tiff/heic —— 本模块返回 null，交 read_image
//   L3b 本轮不可读（仓库无解析库、不新增依赖）：pdf、旧二进制 .doc/.xls/.ppt、音视频、压缩包、可执行
//        本模块同样返回 null（read_file 侧给出明确「不可直读」错误、find_files 标 unreadable:true）。
//
// 只读红线：本模块只读取，绝不修改源文件；docx 解压到 os.tmpdir 的临时目录后即清理。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DOCX_EXTS = new Set([".docx"]);
const XLSX_EXTS = new Set([".xlsx", ".xlsm"]);
// 旧版 OLE 二进制 + PDF：明确无解析库，返回 null（read_file/find_files 侧标注不可直读）
const UNSUPPORTED_EXTS = new Set([".pdf", ".doc", ".xls", ".ppt", ".pptx"]);

/** 该扩展名是否属于「可进程内直读的结构化文档（L2）」。 */
export function isOfficeTextExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return DOCX_EXTS.has(e) || XLSX_EXTS.has(e);
}

/** 把 exceljs 单元格值归一化为可读文本（含公式结果、富文本、超链接、日期）。 */
function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  const v = value as Record<string, unknown>;
  if (typeof v.result !== "undefined") return stringifyCellValue(v.result);   // 公式
  if (typeof v.text !== "undefined") return stringifyCellValue(v.text);        // hyperlink
  if (Array.isArray(v.richText)) {
    return (v.richText as Array<{ text?: unknown }>).map((t) => stringifyCellValue(t.text)).join("");
  }
  return "";
}

async function extractXlsxText(filePath: string): Promise<string | null> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  // 用内存 load(buffer) 而非 readFile：readFile 走 exceljs 内部临时文件 + 流解压，在受限沙箱/测试 worker 下可能阻塞。
  // exceljs 自定义的 Buffer 接口与 @types/node 的 Buffer 名义不兼容，按 load 形参类型精确转换。
  const data: Parameters<typeof workbook.xlsx.load>[0] = fs.readFileSync(filePath) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(data);
  const lines: string[] = [];
  workbook.eachSheet((ws) => {
    lines.push(`# ${ws.name}`);
    ws.eachRow((row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(stringifyCellValue(cell.value)));
      if (cells.length > 0) lines.push(`R${rowNumber}\t` + cells.join("\t"));
    });
  });
  const text = lines.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** 从 docx 的 word/document.xml 原始串剥出正文：段落换行、制表/换行实体、去标签、解常见转义。 */
export function parseDocxXml(xml: string): string {
  let s = xml;
  s = s.replace(/<\/w:p>/g, "\n");            // 段落边界 → 换行
  s = s.replace(/<\/w:tc>/g, "\t");           // 表格单元格边界 → 制表
  s = s.replace(/<\/w:tr>/g, "");             // 表格行结束（段落的 \n 已处理）
  s = s.replace(/<w:br\s*\/>/g, "\n");        // 显式换行
  s = s.replace(/<w:tab\s*\/>/g, "\t");       // 显式制表
  s = s.replace(/<[^>]+>/g, "");              // 去掉所有 XML 标签
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
  // 归一空白：折叠多余空行但保留段落分隔
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractDocxText(filePath: string): Promise<string | null> {
  // 用直接依赖 extract-zip 解到临时目录，只读 word/document.xml，随后清理，绝不改动源文件。
  const { default: extractZip } = await import("extract-zip");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-docx-"));
  try {
    await extractZip(filePath, { dir: tmp });
    const docXml = path.join(tmp, "word", "document.xml");
    if (!fs.existsSync(docXml)) return null;
    const text = parseDocxXml(fs.readFileSync(docXml, "utf8"));
    return text.length > 0 ? text : null;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响读取结果 */ }
  }
}

/**
 * 抽取 Office 文档（L2：docx/xlsx/xlsm）正文纯文本。
 * 非 L2 扩展名（含图片 L3a、PDF/旧二进制 L3b）一律返回 null，由调用方决定「不可直读」处理。
 * 解析失败也返回 null（调用方按不可读降级，绝不抛出中断搜索/读取主流程）。
 */
export async function extractDocText(filePath: string, extIn?: string): Promise<string | null> {
  const ext = (extIn ?? path.extname(filePath)).toLowerCase();
  if (UNSUPPORTED_EXTS.has(ext)) return null;
  try {
    if (DOCX_EXTS.has(ext)) return await extractDocxText(filePath);
    if (XLSX_EXTS.has(ext)) return await extractXlsxText(filePath);
    return null;
  } catch {
    return null;
  }
}
