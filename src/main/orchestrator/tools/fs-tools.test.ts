/**
 * read_file 结构化输出测试
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const { fsFailures } = vi.hoisted(() => ({
  fsFailures: { mkdir: false, write: false, stat: false },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => {
      if (fsFailures.mkdir) {
        fsFailures.mkdir = false;
        throw new Error("mkdir boom");
      }
      return (actual.mkdirSync as (...inner: unknown[]) => unknown)(...args);
    },
    writeFileSync: (...args: unknown[]) => {
      if (fsFailures.write) {
        fsFailures.write = false;
        throw new Error("write boom");
      }
      return (actual.writeFileSync as (...inner: unknown[]) => unknown)(...args);
    },
    statSync: (...args: unknown[]) => {
      if (fsFailures.stat) {
        fsFailures.stat = false;
        throw new Error("stat boom");
      }
      return (actual.statSync as (...inner: unknown[]) => unknown)(...args);
    },
  };
});

// Mock toolRegistry 避免副作用
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: vi.fn(),
    getById: vi.fn(),
    getEnabledTools: vi.fn(() => []),
  },
}));

// electron mock：desktop / userData 都指向临时目录（write_file 相对路径解析与基线落盘依赖）
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

// Mock vision-captioner
vi.mock("../vision-captioner", () => ({
  captionImage: vi.fn(),
}));

// 需要在 mock 之后导入
import "./fs-tools";
import { toolRegistry } from "./registry/tool-registry";
import { ToolExecutionError } from "./registry/tool-execution-error";

// Vitest 5 默认 clearMocks 会在每个测试前清空 mock 调用记录；工具注册发生在
// import "./fs-tools" 的模块顶层，这里在清空前快照一份供全部测试使用
const registeredTools = new Map(
  vi.mocked(toolRegistry.register).mock.calls.map(([tool]) => [tool.id, tool]),
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-tools-test-"));
});

afterEach(() => {
  fsFailures.mkdir = false;
  fsFailures.write = false;
  fsFailures.stat = false;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("read_file structured output", () => {
  it("explicitly marks filesystem text and directory reads as concurrency-safe", () => {
    const readFile = registeredTools.get("read_file");
    const listDir = registeredTools.get("list_dir");
    const readImage = registeredTools.get("read_image");

    expect(readFile?.isConcurrencySafe?.({ path: "C:\\workspace\\a.txt" })).toBe(true);
    expect(listDir?.isConcurrencySafe?.({ path: "C:\\workspace" })).toBe(true);
    expect(readImage?.isConcurrencySafe).toBeUndefined();
  });

  it("returns structured JSON with all required fields", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = registeredTools.get("read_file");
    expect(tool).toBeDefined();

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result).toHaveProperty("path", testFile);
    expect(result).toHaveProperty("startLine", 1);
    expect(result).toHaveProperty("endLine", 5);
    expect(result).toHaveProperty("totalLines", 5);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("truncated", false);
  });

  it("respects startLine parameter", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: testFile, startLine: 3 }));
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.content).toContain("line 3");
    expect(result.content).not.toContain("  1 | line 1");
  });

  it("respects maxLines parameter", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: testFile, startLine: 2, maxLines: 2 }));
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(5);
  });

  it("handles empty file", async () => {
    const testFile = path.join(tmpDir, "empty.txt");
    fs.writeFileSync(testFile, "");

    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.totalLines).toBe(1); // 空文件 split 后有一个空字符串
    expect(result.startLine).toBe(1);
  });

  it("returns error for non-existent file", async () => {
    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: "/nonexistent/file.txt" }));
    expect(result.error).toContain("文件不存在");
  });

  it("returns error for relative path", async () => {
    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: "relative/path.txt" }));
    expect(result.error).toContain("绝对路径");
  });

  it("returns error for directory", async () => {
    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: tmpDir }));
    expect(result.error).toContain("不是文件");
  });

  it("content includes line numbers", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "first\nsecond\nthird");

    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.content).toContain("    1 | first");
    expect(result.content).toContain("    2 | second");
    expect(result.content).toContain("    3 | third");
  });

  it("handles CRLF line endings", async () => {
    const testFile = path.join(tmpDir, "crlf.txt");
    fs.writeFileSync(testFile, "line 1\r\nline 2\r\nline 3");

    const tool = registeredTools.get("read_file");

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.totalLines).toBe(3);
  });
});

describe("write_file truthful contract", () => {
  function writeTool() {
    return registeredTools.get("write_file");
  }

  it("相对文件名落到桌面根目录（learn 模式笔记场景，收编自 write_markdown）", async () => {
    const result = JSON.parse(await writeTool()!.execute({ path: "笔记.md", content: "# 标题" }));
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(tmpDir, "笔记.md"));
    expect(fs.readFileSync(path.join(tmpDir, "笔记.md"), "utf8")).toBe("# 标题");
  });

  it("相对文件名带子目录时自动创建父目录", async () => {
    const result = JSON.parse(await writeTool()!.execute({ path: "test/report.md", content: "x" }));
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "test", "report.md"))).toBe(true);
  });

  it("绑定工作区时相对文件名落到工作区根目录", async () => {
    const wsRoot = path.join(tmpDir, "my-project");
    fs.mkdirSync(wsRoot);
    const result = JSON.parse(await writeTool()!.execute(
      { path: "notes/todo.txt", content: "x" },
      { resolvedWorkspaceRoot: wsRoot },
    ));
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(wsRoot, "notes", "todo.txt"));
  });

  it("相对路径含 .. 穿越时报错拒绝", async () => {
    await expect(writeTool()!.execute({ path: "../escape.txt", content: "x" }))
      .rejects.toMatchObject({
        name: "ToolExecutionError",
        code: "E_PATH_NOT_ABSOLUTE",
        category: "invalid_arguments",
        effectState: "not_applied",
      } satisfies Partial<ToolExecutionError>);
    expect(fs.existsSync(path.join(path.dirname(tmpDir), "escape.txt"))).toBe(false);
  });

  it("returns stat-backed evidence and allows a zero-byte file", async () => {
    const target = path.join(tmpDir, "nested", "empty.txt");
    const result = JSON.parse(await writeTool()!.execute({ path: target, content: "" }));

    expect(result).toEqual({
      success: true,
      tool: "write_file",
      path: target,
      append: false,
      exists: true,
      sizeBytes: 0,
      writtenBytes: 0,
      changes: [
        { file: target, kind: "added", insertions: 0, deletions: 0, diff: [] },
      ],
    });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("rejects mkdir, write, and stat failures with typed errors", async () => {
    const target = path.join(tmpDir, "nested", "file.txt");
    fsFailures.mkdir = true;
    await expect(writeTool()!.execute({ path: target, content: "x" }))
      .rejects.toMatchObject({ code: "E_CREATE_PARENT_FAILED", category: "permission_denied" });

    fsFailures.write = true;
    await expect(writeTool()!.execute({ path: target, content: "x" }))
      .rejects.toMatchObject({ code: "E_WRITE_FILE_FAILED", effectState: "unknown" });

    fsFailures.stat = true;
    await expect(writeTool()!.execute({ path: target, content: "x" }))
      .rejects.toMatchObject({ code: "E_WRITE_EVIDENCE_FAILED", effectState: "unknown" });
  });
});

describe("write_file 覆盖写骤降防护", () => {
  function writeTool() {
    return registeredTools.get("write_file");
  }

  function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
  }

  it("大文件覆盖写骤降过半时拒绝且文件保持原样", async () => {
    const target = path.join(tmpDir, "big.txt");
    const original = lines(100);
    fs.writeFileSync(target, original);

    await expect(writeTool()!.execute({ path: target, content: "半截内容" }))
      .rejects.toMatchObject({
        code: "E_OVERWRITE_DROP_BLOCKED",
        category: "runtime_safety",
        retryable: false,
        effectState: "not_applied",
      });
    // 拒绝发生在落盘之前，原文件未被改动
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("小文件合法缩水不拦截", async () => {
    const target = path.join(tmpDir, "small.txt");
    fs.writeFileSync(target, lines(10));

    const result = JSON.parse(await writeTool()!.execute({ path: target, content: "x\ny" }));
    expect(result.success).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("x\ny");
  });

  it("覆盖写返回行级 diff（旧文全文 remove + 新文全文 add）", async () => {
    const target = path.join(tmpDir, "over.txt");
    fs.writeFileSync(target, "旧一\n旧二");

    const result = JSON.parse(await writeTool()!.execute({ path: target, content: "新一\n新二\n新三" }));
    const change = result.changes[0];
    expect(change.kind).toBe("modified");
    expect(change.insertions).toBe(3);
    expect(change.deletions).toBe(2);
    const removeTexts = change.diff.filter((l: { type: string }) => l.type === "remove").map((l: { text: string }) => l.text);
    const addTexts = change.diff.filter((l: { type: string }) => l.type === "add").map((l: { text: string }) => l.text);
    expect(removeTexts).toEqual(["旧一", "旧二"]);
    expect(addTexts).toEqual(["新一", "新二", "新三"]);
  });

  it("append 不做骤降检查（追加只增不减），原文件末尾无换行时补一个", async () => {
    const target = path.join(tmpDir, "append.txt");
    const original = lines(60);
    fs.writeFileSync(target, original);

    const result = JSON.parse(await writeTool()!.execute({ path: target, content: "尾巴", append: true }));
    expect(result.success).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(original + "\n尾巴");
  });

  it("原文件以换行结尾时追加不重复换行", async () => {
    const target = path.join(tmpDir, "append-nl.txt");
    fs.writeFileSync(target, "第一段\n");

    await writeTool()!.execute({ path: target, content: "第二段", append: true });
    expect(fs.readFileSync(target, "utf8")).toBe("第一段\n第二段");
  });

  it("append 目标不存在时等同新建", async () => {
    const target = path.join(tmpDir, "fresh-append.txt");

    const result = JSON.parse(await writeTool()!.execute({ path: target, content: "初始内容", append: true }));
    expect(result.success).toBe(true);
    expect(result.changes[0].kind).toBe("added");
    expect(fs.readFileSync(target, "utf8")).toBe("初始内容");
  });
});

describe("write_file Review 基线捕获（写盘前）", () => {
  function writeTool() {
    return registeredTools.get("write_file");
  }

  /** 列出某 run 的 before/ 基线文件（含 .absent 后缀）。 */
  function listBaselines(runId: string): string[] {
    const dir = path.join(tmpDir, "cyrene-runs", "reviews", runId, "before");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it("覆盖已有文件时保存 text 基线", async () => {
    const target = path.join(tmpDir, "note.md");
    fs.writeFileSync(target, "旧内容\n第二行\n");

    const result = JSON.parse(await writeTool()!.execute(
      { path: target, content: "新内容" },
      { runId: "run-wf-1" },
    ));
    expect(result.success).toBe(true);

    const baselines = listBaselines("run-wf-1");
    expect(baselines).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, "cyrene-runs", "reviews", "run-wf-1", "before", baselines[0]), "utf8"))
      .toBe("旧内容\n第二行\n");
  });

  it("新建文件时写 absent 标记，同一 run 不重复捕获", async () => {
    const target = path.join(tmpDir, "new-note.md");
    await writeTool()!.execute({ path: target, content: "内容" }, { runId: "run-wf-2" });

    const baselines = listBaselines("run-wf-2");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.absent$/);
    // 惰性快照：同一 run 再次修改同一文件不重复捕获
    await writeTool()!.execute({ path: target, content: "再改" }, { runId: "run-wf-2" });
    expect(listBaselines("run-wf-2")).toHaveLength(1);
  });

  it("无 runId 时不写基线", async () => {
    const target = path.join(tmpDir, "plain.md");
    await writeTool()!.execute({ path: target, content: "x" });
    expect(fs.existsSync(path.join(tmpDir, "cyrene-runs"))).toBe(false);
  });
});
