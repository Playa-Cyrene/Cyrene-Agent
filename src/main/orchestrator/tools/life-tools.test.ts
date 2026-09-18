/**
 * str_replace 工具接线测试（真实调用注册到 mock registry 的 execute）：
 * 参数解析（单发/批量）、原子性、返回体结构、Review 基线捕获。
 * 匹配算法本身的测试在 str-replace-core.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

// 内存版注册表：真实执行 register → getById 链路，但不污染全局
const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

// electron mock：app.getPath("userData") 指向临时目录（Review tracker 基线落点）
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

// 生活工具其余依赖：纯函数直接放行，翻译工具的 fetch 打桩
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "Asia/Shanghai" }));

import { clearExchangeRateCache, registerLifeTools } from "./life-tools";

registerLifeTools();

function getTool(id: string) {
  const tool = registry.get(id) as
    | { execute: (args: Record<string, unknown>, ctx?: { runId?: string }) => Promise<string> }
    | undefined;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-tools-test-"));
  clearExchangeRateCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("str_replace 接线：单发替换", () => {
  it("成功替换并返回结构化结果与 changes", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "# 标题\n\n正文段落。\n");

    const raw = await getTool("str_replace").execute(
      { file_path: file, old_string: "正文段落。", new_string: "修改后的正文。" },
      {},
    );
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.appliedEdits).toBe(1);
    expect(result.whitespaceNormalized).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].file).toBe(file);
    expect(result.changes[0].kind).toBe("modified");
    expect(fs.readFileSync(file, "utf8")).toBe("# 标题\n\n修改后的正文。\n");
  });

  it("未提供 old_string/new_string 与 edits 时报错并回传收到的参数键", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "content");

    const raw = await getTool("str_replace").execute({ file_path: file }, {});
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(result.error).toContain("file_path");
  });

  it("文件不存在时返回 FILE_NOT_FOUND 且不抛异常", async () => {
    const raw = await getTool("str_replace").execute(
      { file_path: path.join(tmpDir, "missing.md"), old_string: "a", new_string: "b" },
      {},
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("FILE_NOT_FOUND");
  });

  it("携带 runId 时在写盘前捕获 Review 基线", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "line1\nline2\n");

    const raw = await getTool("str_replace").execute(
      { file_path: file, old_string: "line1", new_string: "LINE1" },
      { runId: "run-test-123" },
    );
    expect(JSON.parse(raw).success).toBe(true);

    // cyrene-runs/reviews/<runId>/before/ 下应存在基线副本
    const reviewsDir = path.join(tmpDir, "cyrene-runs", "reviews", "run-test-123", "before");
    const copies = fs.readdirSync(reviewsDir);
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(reviewsDir, copies[0]), "utf8")).toBe("line1\nline2\n");
  });
});

describe("str_replace 接线：空文件播种", () => {
  it("空文件 + 空 old_string → new_string 整体写入", async () => {
    const file = path.join(tmpDir, "empty.md");
    fs.writeFileSync(file, "");

    const raw = await getTool("str_replace").execute(
      { file_path: file, old_string: "", new_string: "# 摸底试卷\n\n第一题。" },
      {},
    );
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.appliedEdits).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("# 摸底试卷\n\n第一题。");
    // changes 供 Review 卡片渲染：kind 仍为 modified
    expect(result.changes[0].kind).toBe("modified");
    expect(result.changes[0].insertions).toBeGreaterThan(0);
  });

  it("非空文件 + 空 old_string → 拒绝且不覆盖文件", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "重要内容\n");

    const raw = await getTool("str_replace").execute(
      { file_path: file, old_string: "", new_string: "整文件覆盖" },
      {},
    );
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(result.error).toContain("文件为空时可传空 old_string");
    // 原内容原封不动
    expect(fs.readFileSync(file, "utf8")).toBe("重要内容\n");
  });
});

describe("str_replace 接线：edits 批量", () => {
  it("一次调用完成多处修改，返回 appliedEdits 与多条 changes", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n");

    const raw = await getTool("str_replace").execute(
      {
        file_path: file,
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ],
      },
      {},
    );
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.appliedEdits).toBe(2);
    expect(result.changes).toHaveLength(2);
    expect(fs.readFileSync(file, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  it("任一 edit 失败则整体不落盘（原子性）", async () => {
    const file = path.join(tmpDir, "note.md");
    const original = "alpha\nbeta\n";
    fs.writeFileSync(file, original);

    const raw = await getTool("str_replace").execute(
      {
        file_path: file,
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "not-exist", new_string: "X" },
        ],
      },
      {},
    );
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(result.diagnostic.editIndex).toBe(1);
    // 第一个 edit 成功也不能部分写入
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("失败时不写 Review 基线", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "alpha\n");

    await getTool("str_replace").execute(
      { file_path: file, old_string: "nope", new_string: "x" },
      { runId: "run-fail-case" },
    );

    const reviewsDir = path.join(tmpDir, "cyrene-runs", "reviews", "run-fail-case");
    expect(fs.existsSync(reviewsDir)).toBe(false);
  });

  it("schema 中 edits 与 old_string 均为可选（运行时校验兜底）", () => {
    const tool = registry.get("str_replace") as { inputSchema: { required: string[]; properties: Record<string, unknown> } };
    expect(tool.inputSchema.required).toEqual(["file_path"]);
    expect(tool.inputSchema.properties.edits).toBeDefined();
    expect(tool.inputSchema.properties.old_string).toBeDefined();
  });
});

describe("exchange_rate 结果缓存", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** frankfurter 桩 */
  function makeResp(json: unknown, ok = true, status = 200): Response {
    return {
      ok, status, statusText: ok ? "OK" : "Error",
      json: async () => json,
    } as unknown as Response;
  }

  it("同币种对两次只请求一次，第二次带 [缓存] 标注", async () => {
    const fetchMock = vi.fn(async () => makeResp({ rates: { CNY: 7.12 } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getTool("exchange_rate").execute({ from: "USD", to: "CNY", amount: 100 });
    expect(first).toContain("712.00");
    expect(first.startsWith("[缓存]")).toBe(false);

    const second = await getTool("exchange_rate").execute({ from: "USD", to: "CNY", amount: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.startsWith("[缓存]")).toBe(true);
    expect(second).toContain("356.00");
  });

  it("不同币种对各自请求", async () => {
    const fetchMock = vi.fn(async () => makeResp({ rates: { CNY: 7.12, JPY: 150 } }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("exchange_rate").execute({ from: "USD", to: "CNY" });
    await getTool("exchange_rate").execute({ from: "USD", to: "JPY" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("请求失败的 [错误] 结果不进缓存", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) return makeResp(null, false, 500);
      return makeResp({ rates: { CNY: 7.12 } });
    }));

    const first = await getTool("exchange_rate").execute({ from: "USD", to: "CNY" });
    expect(first.startsWith("[错误]")).toBe(true);

    fail = false;
    const second = await getTool("exchange_rate").execute({ from: "USD", to: "CNY" });
    expect(second).toContain("7.12");
    expect(second.startsWith("[缓存]")).toBe(false);
  });
});
