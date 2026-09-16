// workspace-files 安全边界测试：越界拒绝（含 symlink）、大小上限、二进制识别、隐藏文件过滤。

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDirectory, readFile } from "./workspace-files-ipc";

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cyrene-wsfiles-"));
  outside = mkdtempSync(join(tmpdir(), "cyrene-wsfiles-out-"));
  // 工作区内结构：src/app.ts、README.md、.hidden（应被过滤）、子目录 src
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "const x = 1;\n");
  writeFileSync(join(root, "README.md"), "# hello\n");
  writeFileSync(join(root, ".hidden"), "secret");
  // 越界材料：外部文件 + 指向外部的 symlink
  writeFileSync(join(outside, "secret.txt"), "top secret");
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
  } catch {
    // Windows 无符号链接权限时跳过 symlink 用例（.. 直接越界用例仍覆盖）
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("listDirectory 安全边界", () => {
  it("根目录：隐藏文件被过滤，目录优先排序", async () => {
    const result = await listDirectory(root, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain(".hidden");
    // 目录排在文件前
    expect(result.entries[0].name).toBe("src");
  });

  it("子目录列出内容并返回相对路径", async () => {
    const result = await listDirectory(root, "src");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].relPath).toBe("src/app.ts");
  });

  it("绝对路径注入与 .. 越界被拒绝", async () => {
    const abs = await listDirectory(root, "C:/Windows");
    expect(abs.ok).toBe(false);
    if (!abs.ok) expect(["OUT_OF_ROOT", "NOT_FOUND"]).toContain(abs.code);

    const up = await listDirectory(root, "../");
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.code).toBe("OUT_OF_ROOT");
  });

  it("不存在的路径返回 NOT_FOUND", async () => {
    const result = await listDirectory(root, "no-such-dir");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_FOUND");
  });
});

describe("readFile 安全边界", () => {
  it("读取工作区内文本文件", async () => {
    const result = await readFile(root, "src/app.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("const x = 1;\n");
  });

  it("symlink 指向工作区外被拒绝（OUT_OF_ROOT）", async () => {
    let symlinkExists = true;
    try {
      symlinkExists = (await import("node:fs")).existsSync(join(root, "leak.txt"));
    } catch {
      symlinkExists = false;
    }
    if (!symlinkExists) return;
    const result = await readFile(root, "leak.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUT_OF_ROOT");
  });

  it("目录返回 IS_DIRECTORY", async () => {
    const result = await readFile(root, "src");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IS_DIRECTORY");
  });

  it("二进制文件（大量 \\0）被拒绝", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.alloc(8192, 0));
    const result = await readFile(root, "blob.bin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BINARY");
  });

  it("超过 1MB 的文件被拒绝", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));
    const result = await readFile(root, "big.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_LARGE");
  });
});
