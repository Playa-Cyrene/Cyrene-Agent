import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.root }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() },
}));
vi.mock("../../external-content-paths", () => ({ findSkillPath: () => null }));

import { setCurrentLevel } from "../../permission";
import { registerDocumentTools } from "./document-tools";
import { downloadFileTool } from "./builtin-tools/download-file-tool";
import { registerAstGrepTools } from "./ast-grep-tools";
import { toolRegistry } from "./registry/tool-registry";
import { executeToolDefinition } from "./registry/tool-executor";
import { dispatchToolCall } from "../harness/tool-dispatcher";
import type { ToolContext } from "./registry/tool-context";

registerDocumentTools();
registerAstGrepTools();
const writers = [
  { id: "download_file", ext: ".txt", args: { url: "https://example.test/file" } },
  { id: "write_excel", ext: ".xlsx", args: { sheets: [{ name: "Sheet", headers: ["A"], rows: [[1]] }] } },
  { id: "write_word", ext: ".docx", args: { title: "Report", paragraphs: ["Content"] } },
  { id: "write_pdf", ext: ".pdf", args: { title: "Report", paragraphs: ["Content"] } },
];
let workspace: string;
let outside: string;
beforeEach(() => {
  // 工作区及模拟外部目标都在本用例独占目录内，afterEach 恢复权限和替身后删除整个目录。
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-path-"));
  workspace = path.join(state.root, "workspace"); outside = path.join(state.root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  setCurrentLevel("scoped");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("download", { headers: { "content-type": "text/plain" } })));
});
afterEach(() => {
  setCurrentLevel("read-only");
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  fs.rmSync(state.root, { recursive: true, force: true });
});

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return { userQuery: "", resolvedWorkspaceRoot: workspace, ...extra };
}
function write(writer: typeof writers[number], filename: string, extra: Partial<ToolContext> = {}) {
  const tool = writer.id === "download_file" ? downloadFileTool : toolRegistry.getById(writer.id)!;
  return executeToolDefinition(tool, { ...writer.args, filename }, context(extra));
}

describe("工具真实路径与权限边界", () => {
  it.each(["ast_grep_search", "ast_grep_replace"])("%s 的唯一输入被拒绝时，真实执行链返回权限失败", async (id) => {
    const target = path.join(outside, "source.ts"); fs.writeFileSync(target, "console.log(1);\n");
    setCurrentLevel(id === "ast_grep_search" ? "project-read-only" : "scoped");
    const args = { paths: ["linked"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false };
    const tool = toolRegistry.getById(id)!;
    const outcome = await dispatchToolCall({ id: "denied", name: id, arguments: JSON.stringify(args) }, {
      state: { todoItems: [], uncertainEffects: [] }, tools: [tool], toolContext: context(),
    });
    expect(outcome).toMatchObject({ outcome: "failure", category: "permission_denied", rawResult: { status: "failed", errorCode: "E_AST_PERMISSION_DENIED", effectState: "not_applied" } });
    expect(outcome.message).toContain("工作区外");
    expect(fs.readFileSync(target, "utf8")).toBe("console.log(1);\n");
  });

  it.each(["ast_grep_search", "ast_grep_replace"])("%s 对可访问文件正常零匹配时仍返回成功", async (id) => {
    fs.writeFileSync(path.join(workspace, "source.ts"), "const value = 1;\n");
    const result = await executeToolDefinition(toolRegistry.getById(id)!, {
      paths: ["source.ts"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context());
    expect(result.status).toBe("succeeded");
    const output = JSON.parse(result.output);
    expect(output.matchCount ?? output.changedFiles).toBe(0);
  });

  it.each(["ast_grep_search", "ast_grep_replace"])("%s 保留可访问输入的结果，并说明其余输入被拒绝", async (id) => {
    fs.writeFileSync(path.join(workspace, "source.ts"), "console.log(1);\n");
    fs.writeFileSync(path.join(outside, "source.ts"), "console.log(2);\n");
    setCurrentLevel(id === "ast_grep_search" ? "project-read-only" : "scoped");
    const output = JSON.parse(await toolRegistry.getById(id)!.execute({
      paths: ["linked", "source.ts"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context()));
    expect(output.success).toBe(true);
    expect(output.matchCount ?? output.changedFiles).toBe(1);
    expect(output.permissionErrors).toEqual([expect.stringContaining("工作区外")]);
    expect(fs.readFileSync(path.join(outside, "source.ts"), "utf8")).toBe("console.log(2);\n");
  });

  it("只读子任务禁止 AST 改写时不能记成成功", async () => {
    fs.writeFileSync(path.join(workspace, "source.ts"), "console.log(1);\n");
    expect(await executeToolDefinition(toolRegistry.getById("ast_grep_replace")!, {
      paths: ["source.ts"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context({ readOnly: true, permissionMode: "allow_all" }))).toMatchObject({ status: "failed", category: "permission_denied" });
  });

  it.each(writers)("$id 拒绝通过目录联接在工作区外新建文件", async (writer) => {
    expect(await write(writer, `linked/new/sub/file${writer.ext}`)).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(writers)("$id 拒绝通过目录联接覆盖外部已有文件", async (writer) => {
    const target = path.join(outside, `existing${writer.ext}`);
    fs.writeFileSync(target, "sentinel");
    expect(await write(writer, `linked/existing${writer.ext}`)).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel");
  });

  it.skipIf(process.platform === "win32").each(writers.flatMap((writer) => [false, true].map((missing) => ({ ...writer, missing }))))(
    "$id 拒绝指向外部文件的符号链接（目标不存在=$missing）", async (writer) => {
      const target = path.join(outside, `target${writer.ext}`);
      if (!writer.missing) fs.writeFileSync(target, "sentinel");
      fs.symlinkSync(target, path.join(workspace, `link${writer.ext}`), "file");
      expect(await write(writer, `link${writer.ext}`)).toMatchObject({ status: "failed", category: "permission_denied" });
      if (writer.missing) expect(fs.existsSync(target)).toBe(false);
      else expect(fs.readFileSync(target, "utf8")).toBe("sentinel");
    },
  );

  it.each(writers)("$id 保留授权工作区内的正常写入", async (writer) => {
    expect(await write(writer, `normal/sub/file${writer.ext}`)).toMatchObject({ status: "succeeded" });
    expect(fs.statSync(path.join(workspace, `normal/sub/file${writer.ext}`)).size).toBeGreaterThan(0);
  });

  it.each(writers)("$id 写入工作区内的真实目标并返回请求使用的路径", async (writer) => {
    const targetDir = path.join(workspace, "actual");
    const alias = path.join(workspace, "alias");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, alias, process.platform === "win32" ? "junction" : "dir");
    const download = writer.id === "download_file";
    const finalName = `report${writer.ext}`;
    const result = await write(writer, `alias/${download ? "report" : finalName}`);
    const returnedPath = path.join(alias, finalName);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.output).toBe(download
      ? `[download_file] 已保存：${returnedPath}（0 KiB）`
      : `[${writer.id}] 已生成：${returnedPath}`);
    expect(fs.statSync(path.join(targetDir, finalName)).size).toBeGreaterThan(0);
  });

  it.each(writers)("$id 不越过子任务的只读限制", async (writer) => {
    expect(await write(writer, `file${writer.ext}`, { readOnly: true, permissionMode: "allow_all" })).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.existsSync(path.join(workspace, `file${writer.ext}`))).toBe(false);
  });

  it("下载完成后重新校验实际目标，包括 Content-Type 补出的扩展名", async () => {
    const inbox = path.join(workspace, "inbox"); fs.mkdirSync(inbox);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      fs.renameSync(inbox, path.join(workspace, "old-inbox"));
      fs.symlinkSync(outside, inbox, process.platform === "win32" ? "junction" : "dir");
      return new Response("download", { headers: { "content-type": "text/plain" } });
    });
    expect(await write(writers[0], "inbox/file")).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("Word 异步生成期间替换目录后，最终落盘重新拒绝越界", async () => {
    const inbox = path.join(workspace, "inbox"); fs.mkdirSync(inbox);
    const { Packer } = await import("docx");
    const pack = Packer.toBuffer.bind(Packer);
    vi.spyOn(Packer, "toBuffer").mockImplementationOnce(async (...args) => {
      const buffer = await pack(...args);
      fs.renameSync(inbox, path.join(workspace, "old-inbox"));
      fs.symlinkSync(outside, inbox, process.platform === "win32" ? "junction" : "dir");
      return buffer;
    });
    expect(await write(writers[2], "inbox/report.docx")).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("PDF 生成期间替换原路径上的联接后，最终落盘重新拒绝越界", async () => {
    const inbox = path.join(workspace, "inbox");
    const target = path.join(workspace, "actual");
    fs.mkdirSync(target);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(target, inbox, linkType);
    const { default: PDFDocument } = await import("pdfkit");
    const end = PDFDocument.prototype.end;
    vi.spyOn(PDFDocument.prototype, "end").mockImplementationOnce(function (this: InstanceType<typeof PDFDocument>) {
      end.call(this);
      fs.renameSync(inbox, path.join(workspace, "old-inbox"));
      fs.symlinkSync(outside, inbox, linkType);
    });

    expect(await write(writers[3], "inbox/report.pdf")).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(["ast_grep_search", "ast_grep_replace"])("%s 不经显式联接路径读取或改写受限范围外的源码", async (id) => {
    const target = path.join(outside, "source.ts"); fs.writeFileSync(target, "console.log(1);\n");
    setCurrentLevel(id === "ast_grep_search" ? "project-read-only" : "scoped");
    const output = JSON.parse(await toolRegistry.getById(id)!.execute({
      paths: ["linked"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context()));
    expect(output.matchCount ?? output.changedFiles).toBe(0);
    expect(output.skipped).toContain("linked");
    expect(fs.readFileSync(target, "utf8")).toBe("console.log(1);\n");
  });

  it("AST 改写在 allow_all 下也遵守只读子任务契约", async () => {
    const target = path.join(workspace, "source.ts"); fs.writeFileSync(target, "console.log(1);\n");
    const output = JSON.parse(await toolRegistry.getById("ast_grep_replace")!.execute({
      paths: ["source.ts"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context({ readOnly: true, permissionMode: "allow_all" })));
    expect(output.changedFiles).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("console.log(1);\n");
  });

  it.skipIf(process.platform === "win32").each(["ast_grep_search", "ast_grep_replace"])("%s 检查显式文件符号链接", async (id) => {
    const target = path.join(outside, "source.ts"); fs.writeFileSync(target, "console.log(1);\n");
    fs.symlinkSync(target, path.join(workspace, "link.ts"), "file");
    setCurrentLevel(id === "ast_grep_search" ? "project-read-only" : "scoped");
    const output = JSON.parse(await toolRegistry.getById(id)!.execute({
      paths: ["link.ts"], pattern: "console.log($$$A)", rewrite: "console.warn($$$A)", dryRun: false,
    }, context()));
    expect(output.matchCount ?? output.changedFiles).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("console.log(1);\n");
  });

  it("完全访问仍允许显式联接目标，不把全部链接一律禁用", async () => {
    setCurrentLevel("full");
    expect(await write(writers[0], "linked/full.txt")).toMatchObject({ status: "succeeded" });
    expect(fs.readFileSync(path.join(outside, "full.txt"), "utf8")).toBe("download");
  });
});
