import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { inflateSync } from "zlib";

const state = vi.hoisted(() => ({ root: "", tempRoot: "", tempMode: 0, tempActualMode: 0, tempDirectoryMode: 0, font: "ttc", failText: false, failStream: false, failFont: false, failPublish: false, prematureClose: false, failFinalWrite: false, failFirstFont: false }));
const registry = new Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>();
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: (tool: { id: string; execute: (args: Record<string, unknown>) => Promise<string> }) => registry.set(tool.id, tool) } }));
vi.mock("os", async (original) => {
  const actual = await original<typeof import("os")>();
  return { ...actual, tmpdir: () => state.tempRoot || actual.tmpdir() };
});
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../../external-content-paths", () => ({ findSkillPath: () => null }));
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  const mapped = (file: unknown) => {
    if (file === "C:\\Windows\\Fonts\\msyh.ttc") return ["ttc", "fallback"].includes(state.font) ? "collection.ttc" : null;
    if (file === "C:\\Windows\\Fonts\\simsun.ttc") return ["simsun", "fallback"].includes(state.font) ? "collection.ttc" : null;
    if (file === "C:\\Windows\\Fonts\\simhei.ttf") return state.font === "ttf" ? "standalone.ttf" : null;
    return undefined;
  };
  return { ...actual,
    existsSync: (file: fs.PathLike) => mapped(file) === undefined ? actual.existsSync(file) : !!mapped(file),
    createWriteStream: (file: fs.PathLike, options?: Parameters<typeof actual.createWriteStream>[1]) => {
      if (options && typeof options === "object" && options.flags === "wx") {
        state.tempMode = Number(options.mode);
        state.tempDirectoryMode = actual.statSync(path.dirname(String(file))).mode & 0o777;
      }
      const stream = actual.createWriteStream(state.failStream || (state.failPublish && String(file).endsWith("report.pdf")) ? state.root : file, options);
      if (options && typeof options === "object" && options.flags === "wx") {
        stream.once("open", () => { state.tempActualMode = actual.statSync(file).mode & 0o777; });
      }
      if (state.prematureClose) stream.destroy();
      if (state.failFinalWrite && String(file).endsWith("report.pdf")) stream.once("open", () => stream.destroy(new Error("injected final write failure")));
      return stream;
    },
  };
});
vi.mock("pdfkit", async (original) => {
  const actual = await original<typeof import("pdfkit")>();
  return { default: class extends actual.default {
    font(src: string, family?: string, size?: number) {
      if ((state.failFont && src.includes("Windows")) || (state.failFirstFont && src.endsWith("msyh.ttc"))) return super.font(Buffer.from("invalid font bytes"));
      const mapped = src.endsWith(".ttc") ? "collection.ttc" : src.endsWith(".ttf") ? "standalone.ttf" : null;
      return super.font(mapped ? path.join(import.meta.dirname, "__fixtures__/pdf", mapped) : src, family, size);
    }
    text(...args: Parameters<InstanceType<typeof actual.default>["text"]>) {
      if (state.failText) throw new Error("injected render failure");
      return super.text(...args);
    }
  } };
});
import { registerDocumentTools } from "./document-tools";
registerDocumentTools();
const write = () => registry.get("write_pdf")!.execute({ filename: "nested/report.pdf", title: "中文报告", paragraphs: ["金额 12.50 English"] });
const output = () => path.join(state.root, "nested/report.pdf");
function decodedStreams(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
    try { return inflateSync(Buffer.from(m[1], "latin1")).toString(); } catch { return m[1]; }
  }).join("\n");
}
beforeEach(() => { state.root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-regression-")); state.tempRoot = path.join(state.root, "system-temp"); fs.mkdirSync(state.tempRoot); state.tempMode = 0; state.tempActualMode = 0; state.tempDirectoryMode = 0; state.font = "ttc"; state.failText = false; state.failStream = false; state.failFont = false; state.failPublish = false; state.prematureClose = false; state.failFinalWrite = false; state.failFirstFont = false; });
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  try { expect(fs.readdirSync(state.tempRoot)).toEqual([]); }
  finally {
    fs.rmSync(state.root, { recursive: true, force: true });
    state.tempRoot = "";
    vi.restoreAllMocks();
  }
});
describe("PDF 实际字体和失败输出保护", () => {
  for (const font of ["ttc", "simsun", "ttf"]) it(`使用真实 ${font} 生成含中文 Unicode 映射的完整 PDF`, async () => {
    state.font = font;
    expect(await write()).toContain("已生成");
    const bytes = fs.readFileSync(output());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("%%EOF");
    expect(bytes.toString("latin1")).toContain("/ToUnicode");
    expect(decodedStreams(bytes)).toContain("4e2d");
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });
  it("渲染失败不截断既有文件，且清理临时输出", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true });
    const original = Buffer.from("original PDF must survive"); fs.writeFileSync(output(), original);
    state.font = "ttf"; state.failText = true;
    await expect(write()).rejects.toThrow("injected render failure");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.readFileSync(output())).toEqual(original);
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });
  it("新文件生成失败不留下空 PDF 或临时输出", async () => {
    state.font = "ttf"; state.failText = true;
    await expect(write()).rejects.toThrow("injected render failure");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(output())).toBe(false);
    expect(fs.readdirSync(path.dirname(output()))).toEqual([]);
  });
  for (const failure of ["stream", "publish-open", "premature-close"]) it(`${failure} 失败保留原文件并清理临时输出`, async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true });
    const original = Buffer.from("keep original"); fs.writeFileSync(output(), original);
    state.failStream = failure === "stream";
    state.failPublish = failure === "publish-open";
    state.prematureClose = failure === "premature-close";
    await expect(write()).rejects.toThrow();
    expect(fs.readFileSync(output())).toEqual(original);
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });
  it("成功生成后仍按原语义替换已有目标", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true }); fs.writeFileSync(output(), "old");
    expect(await write()).toBe(`[write_pdf] 已生成：${output()}`);
    expect(fs.readFileSync(output()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("没有系统候选字体时保留默认西文字体降级", async () => {
    state.font = "none";
    const result = await registry.get("write_pdf")!.execute({ filename: "nested/report.pdf", title: "English", paragraphs: ["12.50"] });
    expect(result).toContain("已生成");
    expect(fs.readFileSync(output()).toString("latin1")).toContain("%%EOF");
  });

  it.skipIf(process.platform === "win32")("覆盖保留既有文件的 0600 权限和 inode", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true }); fs.writeFileSync(output(), "private", { mode: 0o600 });
    const inode = fs.statSync(output()).ino;
    await write();
    expect(fs.statSync(output()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(output()).ino).toBe(inode);
  });
  it.skipIf(process.platform === "win32")("沿用符号链接跟随语义而不替换链接", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true });
    const target = path.join(state.root, "original.pdf"); fs.writeFileSync(target, "old", { mode: 0o600 });
    fs.symlinkSync(target, output());
    await write();
    expect(fs.lstatSync(output()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target).subarray(0, 5).toString()).toBe("%PDF-");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("只读目标仍拒绝写入且保留原字节", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true }); fs.writeFileSync(output(), "readonly", { mode: 0o400 });
    try {
      await expect(write()).rejects.toThrow();
      expect(fs.readFileSync(output(), "utf8")).toBe("readonly");
      expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
    } finally { fs.chmodSync(output(), 0o600); }
  });

  it("最终写盘错误上报失败但绝不删除目标文件", async () => {
    fs.mkdirSync(path.dirname(output()), { recursive: true }); fs.writeFileSync(output(), "old");
    state.failFinalWrite = true;
    await expect(write()).rejects.toThrow("injected final write failure");
    // 保持旧写入语义：此阶段可能已截断/部分写入，不作事务回滚承诺。
    expect(fs.existsSync(output())).toBe(true);
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });

  it("首个 TTC 加载失败时继续选用第二个 TTC face", async () => {
    state.font = "fallback"; state.failFirstFont = true;
    expect(await write()).toContain("已生成");
    const bytes = fs.readFileSync(output());
    expect(decodedStreams(bytes)).toContain("4e2d");
    expect(bytes.toString("latin1")).toContain("SimSun");
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });
  it("已有系统字体全坏时上报错误并保留旧输出，不静默降级丢失中文", async () => {
    state.font = "fallback"; state.failFont = true;
    fs.mkdirSync(path.dirname(output()), { recursive: true }); fs.writeFileSync(output(), "old PDF");
    await expect(write()).rejects.toThrow();
    expect(fs.readFileSync(output(), "utf8")).toBe("old PDF");
    expect(fs.readdirSync(path.dirname(output()))).toEqual(["report.pdf"]);
  });

  it("在系统临时目录创建私有中间输出，不要求目标父目录可创建目录", async () => {
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    await write();
    expect(mkdtemp).toHaveBeenCalledWith(path.join(state.tempRoot, "cyrene-pdf-"));
    expect(state.tempMode).toBe(0o600);
    if (process.platform !== "win32") {
      expect(state.tempDirectoryMode).toBe(0o700);
      expect(state.tempActualMode).toBe(0o600);
    }
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("父目录 0555 但已有 PDF 可写时仍能覆盖", async () => {
    const dir = path.dirname(output());
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(output(), "old PDF", { mode: 0o600 });
    const inode = fs.statSync(output()).ino;
    fs.chmodSync(dir, 0o555);
    try {
      expect(await write()).toContain("已生成");
      expect(fs.readFileSync(output()).subarray(0, 5).toString()).toBe("%PDF-");
      expect(fs.statSync(output()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(output()).ino).toBe(inode);
    } finally { fs.chmodSync(dir, 0o755); }
  });

});
