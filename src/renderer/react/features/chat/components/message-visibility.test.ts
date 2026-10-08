import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { createMessageItems, type ChatMessageItem } from "./ChatMessageList";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null },
  CodeHighlighter: () => null,
  Think: () => null,
  ThoughtChain: () => null,
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./file-icon-assets", () => ({ FILE_ICON_URLS: {}, FILE_NAME_MAP: {}, FILE_EXT_MAP: {} }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));

describe("assistantRenderStages", () => {
  it("does not render a Think component for a pending response without real reasoning", () => {
    expect(assistantRenderStages({
      content: "",
      loading: true,
      responseStarted: false,
    })).toEqual([]);
  });

  it("renders standalone reasoning once the model has actually started it", () => {
    expect(assistantRenderStages({
      content: "",
      reasoningStreaming: true,
      responseStarted: false,
    })).toEqual(["reasoning"]);
  });

  it("renders a live run activity before model reasoning arrives", () => {
    expect(assistantRenderStages({
      content: "",
      runActivity: { startedAt: 1_000, reasoningMs: 0 },
    })).toEqual(["activity"]);
  });

  it("adds Cyrene's bubble only after visible reply content starts", () => {
    expect(assistantRenderStages({
      content: "正式回答",
      reasoning: "分析过程",
      reasoningStreaming: false,
      responseStarted: true,
    })).toEqual(["reasoning", "assistant"]);
  });

  it("shows the assistant slot while only transient candidate text exists", () => {
    expect(assistantRenderStages({
      content: "",
      transientText: "实时预览",
      responseStarted: false,
    })).toEqual(["assistant"]);
  });

  it("shows the assistant slot when a generated image has no accompanying text", () => {
    expect(assistantRenderStages({
      content: "",
      responseStarted: false,
      hasAttachments: true,
    })).toEqual(["assistant"]);
  });

  it("keeps a user's collapsed choice while streaming content rerenders", () => {
    const collapsed = updateReasoningExpanded({}, "assistant-1", false);
    expect(resolveReasoningExpanded(collapsed, "assistant-1")).toBe(false);
    expect(resolveReasoningExpanded(collapsed, "assistant-2")).toBe(false);
    expect(updateReasoningExpanded(collapsed, "assistant-1", false)).toBe(collapsed);
  });

  it("defaults every new reasoning chain to collapsed", () => {
    expect(resolveReasoningExpanded({}, "assistant-new")).toBe(false);
  });

  it("keeps stable unique keys for grouped run activity and standalone tools", () => {
    const message: ChatMessageItem = {
      id: "assistant-keys",
      role: "assistant",
      content: "检查完成",
      toolExecutions: [
        { id: "read-1", name: "Read", status: "success" },
        { id: "edit-1", name: "Edit", status: "success" },
      ],
    };
    const activity = createMessageItems([{
      ...message,
      reasoning: "先检查文件",
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 1 },
    }], []);
    expect(activity.map((item) => [item.key, item.role])).toEqual([
      ["assistant-keys-activity", "activity"],
      ["assistant-keys", "assistant"],
    ]);

    const standalone = createMessageItems([message], []);
    expect(standalone.map((item) => [item.key, item.role])).toEqual([
      ["assistant-keys-tool-read-1", "tool"],
      ["assistant-keys-tool-edit-1", "tool"],
      ["assistant-keys", "assistant"],
    ]);
    expect(new Set(standalone.map((item) => item.key)).size).toBe(standalone.length);
    expect(createMessageItems([{ ...message, content: "检查完成，已更新" }], []).map((item) => item.key))
      .toEqual(standalone.map((item) => item.key));
  });

  it("removes hidden streaming Markdown from the DOM after collapse", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("./ChatMessageList.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/<Think[\s\S]*?destroyOnHidden[\s\S]*?>/);
    expect(source).not.toContain("destroyOnHidden={false}");
  });

  it("keeps the shared Streamdown configuration stable", () => {
    const listSource = fs.readFileSync(
      fileURLToPath(new URL("./ChatMessageList.tsx", import.meta.url)),
      "utf8",
    );
    const rendererSource = fs.readFileSync(
      fileURLToPath(new URL("./StreamdownMessageContent.tsx", import.meta.url)),
      "utf8",
    );
    expect(listSource).toContain("<StreamdownMessageContent content={normalized} streaming={Boolean(streaming)} />");
    expect(rendererSource).toContain("const messageComponents: Components");
    expect(rendererSource).toContain("const rehypePlugins: PluggableList");
    expect(rendererSource).toContain("singleDollarTextMath: true");
    expect(rendererSource).not.toContain("componentDidUpdate(previousProps");
    expect(rendererSource).toContain("prismLightMode={false}");
  });
});
