// download_file 纯拒绝路径（不联网、不触 Electron）+ mock fetch 成功路径。
// 安全边界是本工具的核心：路径沙箱、危险后缀黑名单必须先于任何网络请求生效。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// 本文件验证授权写入的功能路径；受限档位由 tool-path-boundaries 回归独立覆盖。
vi.mock("../../permission", async () => ({
  ...await import("../../permission-policy"),
  getCurrentLevel: () => "full",
  ACCESS_LEVEL_LABEL: { full: "完全访问" },
}));
import { downloadFileTool } from "./builtin-tools/download-file-tool";
import type { ToolContext } from "./registry/tool-context";

describe("download_file 拒绝路径（联网之前拦截）", () => {
  const ctx: ToolContext = { userQuery: "下载", resolvedWorkspaceRoot: os.tmpdir() };

  it("非 http(s) 协议拒绝", async () => {
    await expect(downloadFileTool.execute({ url: "ftp://example.com/a.png" }, ctx))
      .resolves.toBe("[错误] url 必须以 http:// 或 https:// 开头");
  });

  it("filename 目录穿越拒绝", async () => {
    const result = await downloadFileTool.execute(
      { url: "https://example.com/a.png", filename: "../evil.png" },
      ctx,
    );
    expect(result).toBe("[错误] 路径不合法（禁止目录穿越或绝对路径）: ../evil.png");
  });

  it("filename 绝对路径拒绝", async () => {
    const result = await downloadFileTool.execute(
      { url: "https://example.com/a.png", filename: "/etc/evil.png" },
      ctx,
    );
    expect(result).toBe("[错误] 路径不合法（禁止目录穿越或绝对路径）: /etc/evil.png");
  });

  it("危险后缀拒绝（.exe/.bat 等）", async () => {
    const result = await downloadFileTool.execute(
      { url: "https://example.com/setup.exe" },
      ctx,
    );
    expect(result).toBe("[错误] 禁止下载可执行/脚本文件: .exe");
  });

  it("filename 含 Windows 非法字符拒绝", async () => {
    const result = await downloadFileTool.execute(
      { url: "https://example.com/a.png", filename: 'a|b.png' },
      ctx,
    );
    expect(result).toBe("[错误] filename 含非法字符（<>:\"|?*）");
  });
});

describe("download_file 成功路径（mock fetch，落盘到临时目录）", () => {
  let workdir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dl-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeCtx(): ToolContext {
    return { userQuery: "下载", resolvedWorkspaceRoot: workdir };
  }

  it("下载二进制并按 URL 推断文件名落盘", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }),
    ) as unknown as typeof fetch;

    const result = await downloadFileTool.execute(
      { url: "https://example.com/pics/cat.png?v=2" },
      makeCtx(),
    );

    const expected = path.join(workdir, "cat.png");
    expect(result).toBe(`[download_file] 已保存：${expected}（0 KiB）`);
    const saved = fs.readFileSync(expected);
    expect(Buffer.compare(saved, Buffer.from(bytes))).toBe(0);
  });

  it("显式 filename 含子目录时自动创建父目录", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;

    const result = await downloadFileTool.execute(
      { url: "https://example.com/get?id=1", filename: "images/pic.txt" },
      makeCtx(),
    );

    const expected = path.join(workdir, "images", "pic.txt");
    expect(result).toContain("[download_file] 已保存");
    expect(fs.readFileSync(expected, "utf8")).toBe("hello");
  });

  it("URL 无扩展名时按 Content-Type 补扩展名", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/jpeg" } }),
    ) as unknown as typeof fetch;

    const result = await downloadFileTool.execute(
      { url: "https://example.com/photo?id=9" },
      makeCtx(),
    );

    const expected = path.join(workdir, "download.jpg");
    expect(result).toContain(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it("URL 与 Content-Type 都给不出扩展名时报错", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("data", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    ) as unknown as typeof fetch;

    const result = await downloadFileTool.execute(
      { url: "https://example.com/get?id=1" },
      makeCtx(),
    );

    expect(result).toContain("[错误] 无法确定文件扩展名");
  });

  it("HTTP 非 2xx 返回错误", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("nope", { status: 404, statusText: "Not Found" }),
    ) as unknown as typeof fetch;

    const result = await downloadFileTool.execute(
      { url: "https://example.com/missing.png" },
      makeCtx(),
    );

    expect(result).toBe("[错误] HTTP 404 Not Found");
  });
});
