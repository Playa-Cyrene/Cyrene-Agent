import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractDocText, isOfficeTextExt, parseDocxXml } from "./office-text-extract";

/** 把文本写进临时目录，返回文件路径（测试后清理）。 */
function tmpFile(name: string, data: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-office-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof data === "string" ? data : data);
  return p;
}

describe("parseDocxXml", () => {
  it("段落边界转换行、去标签、解实体", () => {
    const xml =
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>第一章</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>金额 &amp; 数字 42 &lt;tag&gt;</w:t></w:r></w:p>' +
      "</w:body></w:document>";
    const out = parseDocxXml(xml);
    expect(out).toContain("第一章");
    expect(out).toContain("金额 & 数字 42 <tag>");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("isOfficeTextExt", () => {
  it("docx/xlsx/xlsm 为 L2 可读，其余不是", () => {
    expect(isOfficeTextExt(".docx")).toBe(true);
    expect(isOfficeTextExt(".XLSX")).toBe(true);
    expect(isOfficeTextExt(".xlsm")).toBe(true);
    expect(isOfficeTextExt(".pdf")).toBe(false);
    expect(isOfficeTextExt(".txt")).toBe(false);
  });
});

describe("extractDocText", () => {
  it("对真实 docx（用 docx 库生成）抽出正文", async () => {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun("机密关键词 CYRENE-DOCX-9527")] })] }],
    });
    const buf = await Packer.toBuffer(doc);
    const p = tmpFile("sample.docx", Buffer.from(buf));
    try {
      const text = await extractDocText(p, ".docx");
      expect(text).not.toBeNull();
      expect(text).toContain("CYRENE-DOCX-9527");
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it("对真实 xlsx（用 exceljs 生成）抽出单元格文本", async () => {
    const ExcelJS = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["名称", "数值"]);
    ws.addRow(["CYRENE-XLSX-31415", 9]);
    const p = tmpFile("sample.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    try {
      const text = await extractDocText(p, ".xlsx");
      expect(text).not.toBeNull();
      expect(text).toContain("CYRENE-XLSX-31415");
      expect(text).toContain("名称");
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it("不支持的扩展名 / PDF / 图片返回 null，且不抛异常", async () => {
    const p = tmpFile("x.pdf", Buffer.from("%PDF-1.4 fake"));
    try {
      expect(await extractDocText(p, ".pdf")).toBeNull();
      expect(await extractDocText(p, ".png")).toBeNull();
      expect(await extractDocText(p, ".doc")).toBeNull();
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });
});
