import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";

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

  it("keeps a user's collapsed choice while streaming content rerenders", () => {
    const collapsed = updateReasoningExpanded({}, "assistant-1", false);
    expect(resolveReasoningExpanded(collapsed, "assistant-1")).toBe(false);
    expect(resolveReasoningExpanded(collapsed, "assistant-2")).toBe(false);
    expect(updateReasoningExpanded(collapsed, "assistant-1", false)).toBe(collapsed);
  });

  it("defaults every new reasoning chain to collapsed", () => {
    expect(resolveReasoningExpanded({}, "assistant-new")).toBe(false);
  });

  it("groups a run's reasoning and tools under one activity item with unique keys", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("./ChatMessageList.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('role: "activity"');
    expect(source).toContain('key: `${message.id}-activity`');
    expect(source).toContain('key: `${message.id}-tool-${tools[index].id}`');
    expect(source).not.toContain('key: `${message.id}-tools`');
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
