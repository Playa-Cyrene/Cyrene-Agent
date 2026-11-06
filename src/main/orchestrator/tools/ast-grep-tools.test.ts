/**
 * ast_grep_search / ast_grep_replace 测试。
 *
 * 直接用真实 @ast-grep/napi（Node 环境），在临时目录中验证：
 * - 搜索：位置（1-based）、多文件、语言过滤、截断
 * - 改写：dryRun 默认不写、dryRun=false 写入、CRLF 保留
 * - 安全：路径逃逸拒绝、无效 pattern / language 报错
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerAstGrepTools } from "./ast-grep-tools";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";

// 本文件验证授权改写；真实受限档位和链接边界另有行为回归。
vi.mock("../../permission", async () => ({
  ...await import("../../permission-policy"),
  getCurrentLevel: () => "full",
  ACCESS_LEVEL_LABEL: { full: "完全访问" },
}));

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-test-"));
  ctx = { resolvedWorkspaceRoot: tmpDir } as ToolContext;
  registerAstGrepTools();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, rel), "utf8");
}

async function runSearch(args: Record<string, unknown>): Promise<any> {
  const tool = toolRegistry.getAllTools().find((t) => t.id === "ast_grep_search");
  return JSON.parse(await tool!.execute(args, ctx));
}

async function runReplace(args: Record<string, unknown>): Promise<any> {
  const tool = toolRegistry.getAllTools().find((t) => t.id === "ast_grep_replace");
  return JSON.parse(await tool!.execute(args, ctx));
}

// ── ast_grep_search ─────────────────────────────────────

describe("ast_grep_search", () => {
  it("finds matches with 1-based line/column", async () => {
    writeFile("src/a.ts", "const x = 1;\nconsole.log(x);\n");
    const result = await runSearch({ pattern: "console.log($$$A)", paths: ["src"] });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe("src/a.ts");
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].text).toBe("console.log(x)");
  });

  it("does not match identical text in comments or strings", async () => {
    writeFile(
      "src/a.ts",
      "// console.log(x);\nconst s = 'console.log(x)';\nconsole.log(x);\n",
    );
    const result = await runSearch({ pattern: "console.log($$$A)", paths: ["src"] });

    // AST 级匹配：注释和字符串里的同名文本不算
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].line).toBe(3);
  });

  it("searches multiple files and reports per-file matches", async () => {
    writeFile("a.ts", "console.log(1);\n");
    writeFile("b.ts", "console.log(2);\nconsole.log(3);\n");
    const result = await runSearch({ pattern: "console.log($$$A)" });

    expect(result.matchCount).toBe(3);
    expect(result.filesWithMatches).toBe(2);
  });

  it("filters by language parameter", async () => {
    writeFile("a.ts", "console.log(1);\n");
    writeFile("b.py", "print(1)\n");
    const result = await runSearch({ pattern: "console.log($$$A)", language: "TypeScript" });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe("a.ts");
  });

  it("respects maxMatches and sets truncated", async () => {
    writeFile("a.ts", "console.log(1);\nconsole.log(2);\nconsole.log(3);\n");
    const result = await runSearch({ pattern: "console.log($$$A)", maxMatches: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("returns empty matches when nothing matches", async () => {
    writeFile("a.ts", "const x = 1;\n");
    const result = await runSearch({ pattern: "console.log($$$A)" });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(0);
  });

  it("skips node_modules and hidden dirs", async () => {
    writeFile("node_modules/pkg/a.ts", "console.log(1);\n");
    writeFile(".hidden/a.ts", "console.log(2);\n");
    writeFile("real/a.ts", "console.log(3);\n");
    const result = await runSearch({ pattern: "console.log($$$A)" });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe("real/a.ts");
  });

  it("rejects path traversal outside workspace", async () => {
    const result = await runSearch({ pattern: "console.log($$$A)", paths: ["../../outside"] });

    expect(result.success).toBe(false);
    expect(result.category).toBe("permission_denied");
    expect(result.matchCount).toBe(0);
    expect(result.skipped).toContain("../../outside");
  });

  it("rejects empty pattern", async () => {
    const result = await runSearch({ pattern: "" });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("pattern 参数不能为空");
  });

  it("rejects unsupported language", async () => {
    const result = await runSearch({ pattern: "x", language: "COBOL" });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("不支持的语言");
  });

  it("fails without workspace binding", async () => {
    const tool = toolRegistry.getAllTools().find((t) => t.id === "ast_grep_search");
    const result = JSON.parse(await tool!.execute({ pattern: "x" }, undefined));
    expect(result.success).toBe(false);
  });
});

// ── ast_grep_replace ────────────────────────────────────

describe("ast_grep_replace", () => {
  it("dryRun by default: reports but does not write", async () => {
    writeFile("src/a.ts", "console.log(1);\nconsole.log(2);\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      paths: ["src"],
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.filesToChange).toBe(1);
    expect(result.totalMatches).toBe(2);
    expect(result.planned[0].file).toBe("src/a.ts");
    // 文件未变
    expect(readFile("src/a.ts")).toBe("console.log(1);\nconsole.log(2);\n");
  });

  it("writes when dryRun=false", async () => {
    writeFile("src/a.ts", "console.log(1);\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      paths: ["src"],
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.changedFiles).toBe(1);
    expect(result.changed[0]).toBe("src/a.ts");
    expect(readFile("src/a.ts")).toBe("logger.info(1);\n");
  });

  it("writes multiple files in one call", async () => {
    writeFile("a.ts", "console.log(1);\n");
    writeFile("b.ts", "console.log(2);\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      dryRun: false,
    });

    expect(result.changedFiles).toBe(2);
    expect(readFile("a.ts")).toBe("logger.info(1);\n");
    expect(readFile("b.ts")).toBe("logger.info(2);\n");
  });

  it("preserves CRLF line endings", async () => {
    writeFile("src/a.ts", "const x = 1;\r\nconsole.log(x);\r\nconst y = 2;\r\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      paths: ["src"],
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(readFile("src/a.ts")).toBe("const x = 1;\r\nlogger.info(x);\r\nconst y = 2;\r\n");
  });

  it("keeps unmatched regions untouched", async () => {
    writeFile("src/a.ts", "// header comment\nconst special = 'literal';\nconsole.log(1);\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      paths: ["src"],
      dryRun: false,
    });

    expect(result.success).toBe(true);
    const content = readFile("src/a.ts");
    expect(content).toContain("// header comment");
    expect(content).toContain("const special = 'literal';");
    expect(content).toContain("logger.info(1);");
    expect(content).not.toContain("console.log");
  });

  it("rejects path traversal outside workspace", async () => {
    const result = await runReplace({
      pattern: "x",
      rewrite: "y",
      paths: ["../../outside"],
      dryRun: false,
    });

    expect(result.changedFiles).toBe(0);
    expect(result.skipped).toContain("../../outside");
  });

  it("rejects invalid pattern", async () => {
    const result = await runReplace({ pattern: "", rewrite: "y" });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("pattern 参数不能为空");
  });

  it("reports no-op when pattern matches nothing", async () => {
    writeFile("a.ts", "const x = 1;\n");
    const result = await runReplace({
      pattern: "console.log($$$A)",
      rewrite: "logger.info($$$A)",
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.changedFiles).toBe(0);
    expect(readFile("a.ts")).toBe("const x = 1;\n");
  });

  it("supports captured metavariables in rewrite", async () => {
    writeFile("src/a.ts", "getUser(123);\n");
    const result = await runReplace({
      pattern: "getUser($ID)",
      rewrite: "fetchUser($ID, opts)",
      paths: ["src"],
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(readFile("src/a.ts")).toBe("fetchUser(123, opts);\n");
  });
});
