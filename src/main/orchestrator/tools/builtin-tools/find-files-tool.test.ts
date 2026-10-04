import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findFilesTool, resolveSearchRoot } from "./find-files-tool";

let root = "";

interface OutShape {
  success: boolean;
  errorCode?: string;
  root?: string;
  total?: number;
  truncated?: boolean;
  files?: Array<{
    path: string; name: string; ext: string; sizeBytes: number; modifiedAt: number;
    matchedBy: "name" | "content"; snippet?: string; unreadable?: boolean;
  }>;
}

async function run(args: Record<string, unknown>): Promise<OutShape> {
  return JSON.parse(await findFilesTool.execute(args)) as OutShape;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-find-"));
  fs.writeFileSync(path.join(root, "report_2024.md"), "# 标题 hello");
  fs.writeFileSync(path.join(root, "notes.txt"), "this file has a BANANA-XYZ keyword inside");
  fs.writeFileSync(path.join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "deep.log"), "NESTED-SECRET line");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveSearchRoot", () => {
  it("home 别名解析到已存在目录；非法根返回 null", () => {
    expect(resolveSearchRoot("home")).toBe(os.homedir());
    expect(resolveSearchRoot("")).toBe(os.homedir()); // 无 ctx → home
    expect(resolveSearchRoot("Z:/definitely/not/exists_9f3a")).toBeNull();
  });
  it("给定绝对目录原样返回", () => {
    expect(resolveSearchRoot(root)).toBe(path.normalize(root));
  });
});

describe("find_files 文件名匹配", () => {
  it("模糊名命中，带元数据；BFS 递归到子目录", async () => {
    const out = await run({ query: "report", path: root });
    expect(out.success).toBe(true);
    expect(out.root).toBe(path.normalize(root));
    const hit = out.files!.find((f) => f.name === "report_2024.md");
    expect(hit).toBeDefined();
    expect(hit!.matchedBy).toBe("name");
    expect(hit!.ext).toBe(".md");
    expect(hit!.sizeBytes).toBeGreaterThan(0);
    expect(hit!.modifiedAt).toBeGreaterThan(0);
  });

  it("图片按名命中时标 unreadable（需 read_image）", async () => {
    const out = await run({ query: "photo", path: root });
    const hit = out.files!.find((f) => f.name === "photo.png");
    expect(hit).toBeDefined();
    expect(hit!.unreadable).toBe(true);
  });
});

describe("find_files 内容匹配", () => {
  it("searchContent 对 L1 文本命中，matchedBy=content 且带 ≤200 字 snippet", async () => {
    const out = await run({ query: "BANANA-XYZ", path: root, searchContent: true });
    const hit = out.files!.find((f) => f.name === "notes.txt");
    expect(hit).toBeDefined();
    expect(hit!.matchedBy).toBe("content");
    expect(hit!.snippet).toContain("BANANA-XYZ");
    expect(hit!.snippet!.length).toBeLessThanOrEqual(201);
  });

  it("默认不读内容：内容命中但开关关闭 → 不返回该文件", async () => {
    const out = await run({ query: "BANANA-XYZ", path: root });
    expect(out.files!.find((f) => f.name === "notes.txt")).toBeUndefined();
  });

  it("searchContent 命中子目录里的深层文本", async () => {
    const out = await run({ query: "NESTED-SECRET", path: root, searchContent: true });
    expect(out.files!.some((f) => f.name === "deep.log")).toBe(true);
  });
});

describe("find_files 过滤与上限", () => {
  it("extensions 只保留指定扩展名", async () => {
    const out = await run({ query: "", path: root });
    expect(out.errorCode).toBe("INVALID_ARGUMENT");
    const md = await run({ query: "report", path: root, extensions: ["md"] });
    expect(md.files!.every((f) => f.ext === ".md")).toBe(true);
  });

  it("limit 截断返回条数", async () => {
    // 三个文件都含 e（report_2024.md, notes.txt, photo.png, deep.log 均含 e）
    const out = await run({ query: "e", path: root, limit: 2 });
    expect(out.total).toBeLessThanOrEqual(2);
  });

  it("无法解析的搜索根返回 ROOT_NOT_FOUND", async () => {
    const out = await run({ query: "x", path: "Z:/nope_9f3a" });
    expect(out.errorCode).toBe("ROOT_NOT_FOUND");
  });
});
