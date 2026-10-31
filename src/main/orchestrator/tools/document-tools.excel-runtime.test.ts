import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";

it("write_excel 在原生 Node 动态导入下生成可读的多工作表 XLSX", () => {
  // 与 desktop-typescript.mjs 相同的 CJS/ES2022 转译，不让 Vitest 的模块互操作掩盖问题。
  const root = path.resolve(".build-temp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "excel-runtime-"));
  try {
    const source = fs.readFileSync(path.resolve("src/main/orchestrator/tools/document-tools.ts"), "utf8");
    fs.writeFileSync(path.join(dir, "document-tools.cjs"), transformSync(source, {
      loader: "ts", platform: "node", target: "es2022", format: "cjs",
    }).code);
    // 只替换 Electron/注册表等宿主边界；ExcelJS 的 import、写盘及读回均使用真实依赖。
    const result = execFileSync(process.execPath, ["-e", `
      const Module = require('node:module');
      const path = require('node:path');
      const registry = new Map();
      const dir = process.argv[1];
      const load = Module._load;
      Module._load = function(id, ...args) {
        if (id === 'electron') return {app: {getPath: () => dir}};
        if (id === './registry/tool-registry') return {toolRegistry: {register: t => registry.set(t.id, t)}};
        if (id === '../../external-content-paths') return {findSkillPath: () => null};
        if (id === '../review/run-review-tracker') return {getRunReviewTracker: () => { throw new Error('unexpected review call'); }};
        return load.call(this, id, ...args);
      };
      require(path.join(dir, 'document-tools.cjs')).registerDocumentTools();
      (async () => {
        const message = await registry.get('write_excel').execute({
          filename: 'nested/report.xlsx',
          sheets: [
            {name: '预算', headers: ['名称', '金额'], rows: [['中文测试', 12.5], ['第二行', 2000]]},
            {name: '统计', headers: ['年份'], rows: [[2026]]}
          ],
          colors: {headerFill: 'FF123456'}
        }, {resolvedWorkspaceRoot: dir});
        const ExcelJS = (await import('exceljs')).default;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path.join(dir, 'nested/report.xlsx'));
        const sheet = workbook.getWorksheet('预算');
        console.log(JSON.stringify({message, names: workbook.worksheets.map(s => s.name),
          text: sheet.getCell('A2').value, number: sheet.getCell('B2').value,
          fill: sheet.getCell('A1').fill.fgColor.argb, numberFormat: sheet.getCell('B2').numFmt,
          frozen: sheet.views[0].ySplit, filter: sheet.autoFilter,
          year: workbook.getWorksheet('统计').getCell('A2').value}));
      })().catch(error => {console.error(error); process.exitCode = 1;});
    `, dir], { encoding: "utf8", timeout: 20_000 });
    const data = JSON.parse(result.trim().split("\n").at(-1)!);
    expect(data).toMatchObject({
      names: ["预算", "统计"], text: "中文测试", number: 12.5,
      fill: "FF123456", numberFormat: "#,##0.00", frozen: 1, filter: "A1:B3", year: 2026,
    });
    expect(data.message).toContain(path.join(dir, "nested/report.xlsx"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
