// @vitest-environment jsdom
// A1-S 语义清单第 10 项补充（有状态重置验证）：
// SSR 纯函数性只能证明"无状态渲染不串内容"，不能证明"同一个已挂载实例"在收到
// 非前缀内容替换（discard / round 切换 / transientText 归零）时，库内 block 缓存
// 会正确重置。此处在 jsdom 下挂载同一实例，依次 A → B → 空串 → C 更新 props，
// 断言每步旧内容消失、新内容完整出现；另覆盖 key 变化（messageId/roundId 切换）
// 导致的重挂载场景。浏览器内的多轮切换实测由 paired 矩阵（mixed 数据集）覆盖。
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 与 streamdown-spike.test.ts 相同的 mock 集：只隔离浏览器专属依赖，其余走真实实现
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
vi.mock("./streamdown-spike.css", () => ({}));

import { FileLinkContext, MessageStreamingContext } from "../react/features/chat/components/ChatMessageList";
import { StreamdownSpikeContent } from "./streamdown-spike";

// React 19 的 act 需要显式声明测试环境，否则告警
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT_A = "第一轮正文AAA开头\n\n- 列表项A1\n- 列表项A2\n\n**加粗AAA**";
const CONTENT_B = "完全不同的第二轮BBB开头\n\n1. 有序B1\n2. 有序B2\n\n`行内代码B`";
const CONTENT_C = "第三轮CCC普通段落";

let container: HTMLDivElement;
let root: Root;

/** 在同一 root 上更新 props（保持实例不重挂载） */
function update(content: string, key?: string) {
  act(() => {
    root.render(
      React.createElement(
        FileLinkContext.Provider,
        { value: { workspaceRoot: null, openFile: null } },
        React.createElement(
          MessageStreamingContext.Provider,
          { value: true },
          React.createElement(StreamdownSpikeContent, { key, content }),
        ),
      ),
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("A1-S 有状态重置：同一挂载实例的非前缀内容替换", () => {
  it("A → B → 空串 → C：每步旧内容消失、新内容完整出现", () => {
    update(CONTENT_A);
    expect(container.textContent).toContain("第一轮正文AAA开头");
    expect(container.textContent).toContain("加粗AAA");
    expect(container.textContent).toContain("列表项A1");

    // 非前缀整体替换（模拟 discard 后换新正文）
    update(CONTENT_B);
    expect(container.textContent).toContain("第二轮BBB开头");
    expect(container.textContent).toContain("有序B1");
    expect(container.textContent).toContain("行内代码B");
    expect(container.textContent).not.toContain("AAA");
    expect(container.textContent).not.toContain("列表项");

    // 空串（模拟 transientText 归零 / 清空候选）
    update("");
    expect(container.textContent).not.toContain("BBB");
    expect(container.textContent).not.toContain("有序");

    // 空串后再来新内容（模拟新一轮 candidate）
    update(CONTENT_C);
    expect(container.textContent).toContain("第三轮CCC普通段落");
    expect(container.textContent).not.toContain("BBB");
    expect(container.textContent).not.toContain("AAA");
  });

  it("key 变化（messageId/roundId 切换）触发重挂载：新内容干净出现", () => {
    update(CONTENT_A, "msg-1");
    expect(container.textContent).toContain("第一轮正文AAA开头");

    update(CONTENT_B, "msg-2");
    expect(container.textContent).toContain("第二轮BBB开头");
    expect(container.textContent).not.toContain("AAA");
    expect(container.textContent).not.toContain("列表项A1");
  });
});
