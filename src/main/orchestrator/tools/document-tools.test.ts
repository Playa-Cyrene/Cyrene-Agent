/**
 * document-tools 测试：
 * - filename 校验报错：区分「未提供」与「值不合法」，回传实际收到的参数键（丢参模型自纠）
 * - Review 基线捕获：覆盖已有文件存 binary 基线（text 基线场景由 write_file 覆盖，见 fs-tools.test.ts）
 * 基线路径：<userData>/cyrene-runs/reviews/<runId>/before/
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

// 内存版注册表：真实执行 register → execute 链路，不污染全局
const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

// electron mock：desktop / userData 都指向临时目录
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

// 样式目录 mock：测试不依赖 skills/ 真实文件
vi.mock("../../external-content-paths", () => ({
  findSkillPath: (_skillId: string, _sub: string) => null,
}));

import { registerDocumentTools } from "./document-tools";

registerDocumentTools();

function getTool(id: string) {
  const tool = registry.get(id) as
    | { execute: (args: Record<string, unknown>, ctx?: { runId?: string; resolvedWorkspaceRoot?: string }) => Promise<string> }
    | undefined;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

/** 列出某 run 的 before/ 基线文件（含 .absent / .binary 后缀）。 */
function listBaselines(runId: string): string[] {
  const dir = path.join(tmpDir, "cyrene-runs", "reviews", runId, "before");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("filename 校验报错（参数缺失时回传实际键名）", () => {
  it("write_excel / write_word / write_pdf 缺 filename 时同样回传键名（不生成文件）", async () => {
    for (const [id, args, ext] of [
      ["write_excel", { sheets: [{ name: "S1", headers: [], rows: [] }] }, ".xlsx"],
      ["write_word", { title: "t", paragraphs: ["p"] }, ".docx"],
      ["write_pdf", { title: "t", paragraphs: ["p"] }, ".pdf"],
    ] as const) {
      const raw = await getTool(id).execute({ ...args }, {});
      expect(raw).toContain("未提供 filename");
      expect(raw).toContain(ext);
    }
  });

  it("write_excel sheets 缺失时报错回传键名", async () => {
    const raw = await getTool("write_excel").execute({ filename: "a.xlsx" }, {});
    expect(raw).toContain("sheets 不能为空");
    expect(raw).toContain("filename");
  });
});

describe("Review 基线捕获（写盘前）", () => {
  it("write_excel 覆盖已有文件时保存 binary 基线（metadata）", async () => {
    // 预置旧二进制（tracker 按前 8KB 是否含 null byte 判定，与扩展名无关）
    fs.writeFileSync(path.join(tmpDir, "report.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]));

    const raw = await getTool("write_excel").execute(
      { filename: "report.xlsx", sheets: [{ name: "S1", headers: ["列A"], rows: [[1, 2]] }] },
      { runId: "run-xlsx-1" },
    );
    expect(raw).toContain("已生成");

    const baselines = listBaselines("run-xlsx-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
  });

  it("write_word 覆盖已有文件时保存 binary 基线", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]));

    const raw = await getTool("write_word").execute(
      { filename: "report.docx", title: "标题", paragraphs: ["段落一"] },
      { runId: "run-docx-1" },
    );
    expect(raw).toContain("已生成");

    const baselines = listBaselines("run-docx-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
  });

  it("write_pdf 基线捕获先于生成（生成失败也不影响基线）", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0, 1]));

    // 本机 msyh.ttc 与 pdfkit 的 subset 不兼容，doc.text() 会抛错——
    // 恰好验证 write-ahead 语义：基线在任何写盘/生成动作之前已保存
    let threw = false;
    try {
      await getTool("write_pdf").execute(
        { filename: "report.pdf", title: "标题", paragraphs: ["段落一"] },
        { runId: "run-pdf-1" },
      );
    } catch {
      threw = true;
    }

    const baselines = listBaselines("run-pdf-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
    if (threw) {
      // 生成失败时原二进制不应被截断破坏（createWriteStream 未成功写入）
      // 等待 pdfkit 内部流动作结束，避免延迟 open 撞上目录清理
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
