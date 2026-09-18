// A1-S spike 语义清单验证（issue A1-S 方案第 6 条，10 项）：
// 用真实 Streamdown（非 mock）在 node SSR 下验证解析与安全语义。
// 浏览器专属行为（Shiki 高亮、mermaid 成功渲染、动画、库内 block 缓存的重置）
// 由 perf harness 页面与 paired 矩阵实测覆盖，此处不重复。
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// 与 ChatMessageList.test.ts 相同的 mock 集：只隔离浏览器专属依赖，其余走真实实现
vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("code", { "data-code-stub": "1" }, children),
    Think: () => null,
    ThoughtChain: () => null,
  };
});
vi.mock("@ant-design/x-markdown", async () => {
  const ReactModule = await import("react");
  return {
    XMarkdown: ({ content }: { content?: string }) => ReactModule.createElement("div", null, content ?? null),
  };
});
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));
vi.mock("../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
// node 环境不解析 css（spike 样式已由构建层/运行层单独验证）
vi.mock("./streamdown-spike.css", () => ({}));

import { FileLinkContext, MessageStreamingContext } from "../react/features/chat/components/ChatMessageList";
import { StreamdownSpikeContent } from "./streamdown-spike";

function renderSpike(
  content: string,
  opts?: { streaming?: boolean; workspaceRoot?: string; openFile?: (p: string, l?: number) => void },
): string {
  const streaming = opts?.streaming ?? true;
  return renderToStaticMarkup(
    React.createElement(
      FileLinkContext.Provider,
      { value: { workspaceRoot: opts?.workspaceRoot, openFile: opts?.openFile } },
      React.createElement(
        MessageStreamingContext.Provider,
        { value: streaming },
        React.createElement(StreamdownSpikeContent, { content }),
      ),
    ),
  );
}

describe("A1-S 语义清单：Streamdown + Cyrene 必要语义", () => {
  it("1. 未闭合围栏：remend 补全为代码块，内容不丢失", () => {
    const markup = renderSpike("段落\n\n```ts\nconst a = 1;");
    expect(markup).toContain("const a = 1");
    // SpikePre 分流：非 mermaid/svg 代码块走 CodeHighlighter（此处为 SSR stub）
    expect(markup).toContain("data-code-stub");
  });

  it("2. 表格：GFM 表格渲染为 table 结构", () => {
    const markup = renderSpike("标题甲|标题乙\n---|---\n1|2", { streaming: false });
    expect(markup).toContain("<table");
    expect(markup).toContain("标题甲");
  });

  it("3. 列表连续性：多项列表完整渲染", () => {
    const markup = renderSpike("顺序：\n\n1. 甲\n2. 乙\n3. 丙");
    expect(markup).toContain("<ol");
    expect(markup).toContain("甲");
    expect(markup).toContain("丙");
  });

  it("4. 后置链接定义：引用定义与使用分属不同 block 时的行为（探测记录）", () => {
    // Streamdown 按 block 分割解析：[text][ref] 与 [ref]: url 若被分到不同 block，
    // 单块解析时引用未定义会渲染为纯文本。实测行为见断言与 A1-S 报告。
    const markup = renderSpike("[文本][ref]\n\n中间段落\n\n[ref]: https://example.com", { streaming: false });
    expect(markup).toContain("文本");
    // 记录性断言：分块下引用定义是否生效（不作为失败条件，行为写入报告）
    const hasLink = markup.includes('href="https://example.com"');
    console.log(`[a1-s] 后置链接定义分块下生效: ${hasLink}`);
    expect(typeof hasLink).toBe("boolean");
  });

  it("5. LaTeX：块级公式经 KaTeX 渲染", () => {
    const markup = renderSpike("公式：\n\n$$E=mc^2$$");
    expect(markup).toContain("katex");
    // 注意：@streamdown/math 默认 singleDollarTextMath=false，行内 $...$ 不解析——
    // 与 XMarkdown 的行为差异记录进 A1-S 报告（转正时需对齐）
    const inline = renderSpike("行内 $E=mc^2$ 不渲染");
    console.log(`[a1-s] 行内单美元公式渲染为 KaTeX: ${inline.includes("katex")}`);
    expect(inline).toContain("行内");
  });

  it("6. Mermaid：流式占位、非流式走 MermaidBlock", () => {
    const code = "```mermaid\ngraph TD\nA-->B\n```";
    const streamingMarkup = renderSpike(code);
    expect(streamingMarkup).toContain("cy-mermaid--pending");
    // node 下 beautiful-mermaid 无 DOM，非流式预期走降级源码展示（成功渲染由浏览器实测覆盖）
    const doneMarkup = renderSpike(code, { streaming: false });
    expect(doneMarkup).toContain("cy-mermaid");
  });

  it("7. SVG Card：svg 围栏分流到 SvgCardBlock", () => {
    const markup = renderSpike("```svg\n<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>\n```");
    expect(markup).toContain("cy-svg-card");
  });

  it("8. file:/// 链接：界内 chip / 越界降级 / 外链新窗口", () => {
    const openFile = (_p: string, _l?: number) => {};
    const inside = renderSpike("看 [文件](file:///E:/ws/src/a.ts#L12) 的实现", {
      streaming: false,
      workspaceRoot: "E:/ws",
      openFile,
    });
    expect(inside).toContain("cy-file-link");
    expect(inside).not.toContain("is-plain");

    const outside = renderSpike("看 [文件](file:///C:/Users/x.md) 的内容", {
      streaming: false,
      workspaceRoot: "E:/ws",
      openFile,
    });
    expect(outside).toContain("cy-file-link is-plain");

    const external = renderSpike("见 [文档](https://example.com)", { streaming: false });
    expect(external).toContain('target="_blank"');
  });

  it("9. 原始 HTML 与危险 URL：sanitize 剥离 script/事件属性/javascript: 协议", () => {
    const markup = renderSpike(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[点我](javascript:alert(1))",
      { streaming: false },
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onerror");
    expect(markup.toLowerCase()).not.toContain('href="javascript:');
  });

  it("10. 非前缀内容突变：替换后渲染新内容、无旧内容残留（SSR 层）", () => {
    // 模拟 discard / round 切换：transientText 归零后换新正文。
    // SSR 是无状态渲染，此处验证渲染纯函数性；库内 block 缓存的前缀检测与重置
    // 由 paired 矩阵（mixed 数据集多轮切换）在浏览器内实测覆盖。
    const first = renderSpike("第一轮的正文内容AAA");
    const second = renderSpike("完全不同的第二轮正文BBB");
    expect(first).toContain("AAA");
    expect(first).not.toContain("BBB");
    expect(second).toContain("BBB");
    expect(second).not.toContain("AAA");
  });
});
