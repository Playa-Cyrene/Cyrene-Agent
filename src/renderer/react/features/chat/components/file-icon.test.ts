// 文件图标解析：特殊文件名优先 → 后缀匹配 → 通用兜底。
// svg 资产 import 在 node 测试环境不可加载，mock 掉映射数据只测解析逻辑。
import { describe, expect, it, vi } from "vitest";

vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: {
    default: "default-url",
    npm: "npm-url",
    typescript: "typescript-url",
    react: "react-url",
    python: "python-url",
    go: "go-url",
    markdown: "markdown-url",
    docker: "docker-url",
  },
  FILE_NAME_MAP: { "package.json": "npm", dockerfile: "docker" },
  FILE_EXT_MAP: { ts: "typescript", tsx: "react", py: "python", go: "go", md: "markdown" },
}));

import { resolveFileIconUrl } from "./file-icon";

describe("resolveFileIconUrl", () => {
  it("特殊文件名优先于后缀", () => {
    expect(resolveFileIconUrl("package.json")).toBe("npm-url");
    expect(resolveFileIconUrl("some/dir/package.json")).toBe("npm-url");
  });

  it("按后缀匹配品牌图标", () => {
    expect(resolveFileIconUrl("main.ts")).toBe("typescript-url");
    expect(resolveFileIconUrl("App.tsx")).toBe("react-url");
    expect(resolveFileIconUrl("a/b/c/main.py")).toBe("python-url");
  });

  it("未知后缀回落到通用文件图标", () => {
    expect(resolveFileIconUrl("nop-60s.cmd")).toBe("default-url");
    expect(resolveFileIconUrl("notes.txt")).toBe("default-url");
    expect(resolveFileIconUrl("archive.zip")).toBe("default-url");
  });

  it("兼容 Windows 反斜杠路径与大小写", () => {
    expect(resolveFileIconUrl("C:\\Users\\x\\main.go")).toBe("go-url");
    expect(resolveFileIconUrl("README.MD")).toBe("markdown-url");
    expect(resolveFileIconUrl("DOCKERFILE")).toBe("docker-url");
  });
});
