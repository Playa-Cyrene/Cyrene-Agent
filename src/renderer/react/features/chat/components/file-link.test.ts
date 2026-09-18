// file-link 单测：href 解析（编码/行号片段）与工作区边界判断。
// 纯函数测试，不依赖渲染环境。

import { describe, expect, it } from "vitest";
import { parseFileLinkHref, relativePathInsideWorkspace } from "./file-link";

describe("parseFileLinkHref", () => {
  it("解析基本路径与行号区间", () => {
    const target = parseFileLinkHref("file:///E:/Cyrene-Agent/src/main/app.ts#L12-L30");
    expect(target).toEqual({ absPath: "E:/Cyrene-Agent/src/main/app.ts", lineStart: 12, lineEnd: 30 });
  });

  it("单行片段 #L45 → lineStart 与 lineEnd 相同", () => {
    const target = parseFileLinkHref("file:///E:/x/a.ts#L45");
    expect(target).toEqual({ absPath: "E:/x/a.ts", lineStart: 45, lineEnd: 45 });
  });

  it("无行号片段 → 行号缺省", () => {
    const target = parseFileLinkHref("file:///E:/x/a.ts");
    expect(target).toEqual({ absPath: "E:/x/a.ts" });
  });

  it("中文与空格路径（百分号编码）正确解码", () => {
    const target = parseFileLinkHref("file:///C:/Users/u/Desktop/ts/AI%E6%96%B0%E9%97%BB.md");
    expect(target?.absPath).toBe("C:/Users/u/Desktop/ts/AI新闻.md");
  });

  it("反斜杠路径统一为正斜杠", () => {
    const target = parseFileLinkHref("file:///E:%5Cx%5Ca.ts");
    expect(target?.absPath).toBe("E:/x/a.ts");
  });

  it("非法编码不抛错，按原文降级", () => {
    const target = parseFileLinkHref("file:///E:/x/%E0%A4%A.ts");
    expect(target?.absPath).toBe("E:/x/%E0%A4%A.ts");
  });

  it("非 file 协议 / 错误片段返回 null 或忽略行号", () => {
    expect(parseFileLinkHref("https://example.com/a.ts")).toBeNull();
    expect(parseFileLinkHref("file:///E:/x/a.ts#section")).toEqual({ absPath: "E:/x/a.ts" });
    expect(parseFileLinkHref("file:///E:/x/a.ts#l12")).toEqual({ absPath: "E:/x/a.ts" });
  });
});

describe("relativePathInsideWorkspace", () => {
  const root = "E:\\Cyrene-Agent";

  it("工作区内文件 → 返回正斜杠相对路径", () => {
    expect(relativePathInsideWorkspace("E:/Cyrene-Agent/src/main/app.ts", root))
      .toBe("src/main/app.ts");
  });

  it("大小写不敏感（Windows 盘符与目录）", () => {
    expect(relativePathInsideWorkspace("e:/cyrene-agent/src/a.ts", root)).toBe("src/a.ts");
  });

  it("反斜杠绝对路径也能匹配", () => {
    expect(relativePathInsideWorkspace("E:\\Cyrene-Agent\\src\\a.ts", root)).toBe("src/a.ts");
  });

  it("越界路径返回 null（桌面等）", () => {
    expect(relativePathInsideWorkspace("C:/Users/u/Desktop/ts/AI新闻.md", root)).toBeNull();
  });

  it("前缀相似但非同一目录返回 null（E:/proj-x 不是 E:/proj）", () => {
    expect(relativePathInsideWorkspace("E:/Cyrene-Agent-x/a.ts", root)).toBeNull();
  });

  it("路径等于工作区根 → '.'；空根 → null", () => {
    expect(relativePathInsideWorkspace("E:/Cyrene-Agent", root)).toBe(".");
    expect(relativePathInsideWorkspace("E:/Cyrene-Agent/a.ts", "")).toBeNull();
  });
});
