import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: () => null,
    Think: ({ icon, title, children }: { icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, icon, title, children),
    ThoughtChain: () => null,
  };
});
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
// svg 资产 import 在 node 测试环境不可加载，mock 掉图标资产表
vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: { default: "default-url" },
  FILE_NAME_MAP: {},
  FILE_EXT_MAP: {},
}));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));

import { AskUserQaContent, assembleMessageItems, createMessageItems, formatChannelSourceLabel, MarkdownContent, resolveChannelConversationLabel, RunActivityDetail, ToolFileLink, type ChatMessageItem, type EnabledSticker } from "./ChatMessageList";
import { FileLinkContext } from "./FileLinkContext";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import { buildFlatRunTimeline } from "./agent-rounds";
import type { ToolFileChange } from "../../../../../shared/chat-types";

describe("tool file preview links", () => {
  function renderLink(filePath: string, workspaceRoot?: string, openFile?: (relPath: string) => void, changes?: ToolFileChange[]) {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    return renderToStaticMarkup(React.createElement(FileLinkContext.Provider,
      { value: { workspaceRoot, openFile } }, React.createElement(ToolFileLink, { filePath, changes })));
  }

  it.each(["D:\\项目\\src\\characters.ts", "src/characters.ts"])("renders only the filename and icon for %s", (filePath) => {
    const html = renderLink(filePath, "D:\\项目", () => {});
    expect(html).toContain("<button");
    expect(html).toContain(`title="${filePath}"`);
    expect(html).toContain("cy-file-link__icon");
    expect(html).toContain(">characters.ts</span>");
    expect(html).not.toContain("<code");
    expect(html.replace(/title="[^"]*"/, "")).not.toContain("src/");
  });

  it.each([
    ["D:/项目外/a.ts", "D:/项目", true],
    ["src/a.ts", undefined, true],
    ["src/a.ts", "D:/项目", false],
  ] as const)("keeps unavailable preview targets readable without a dead button", (filePath, root, hasCallback) => {
    const html = renderLink(filePath, root, hasCallback ? () => {} : undefined);
    expect(html).not.toContain("<button");
    expect(html).toContain("is-unavailable");
    expect(html).toContain(">a.ts</span>");
  });

  it("places the matching file's change counts after its name across absolute and relative paths", () => {
    const changes: ToolFileChange[] = [
      { file: "src/other.ts", kind: "modified", insertions: 99, deletions: 88 },
      { file: "src/characters.ts", kind: "modified", insertions: 20, deletions: 19 },
    ];
    const html = renderLink("D:\\项目\\src\\Characters.ts", "D:\\项目", () => {}, changes);
    expect(html).toContain('class="is-add">+20</span>');
    expect(html).toContain('class="is-remove">-19</span>');
    expect(html.indexOf(">Characters.ts</span>")).toBeLessThan(html.indexOf("+20</span>"));
    expect(html).not.toContain("+99");
    expect(html).not.toContain("-88");
  });

  it("shows only nonzero counts and leaves unmatched files without invented statistics", () => {
    const changes: ToolFileChange[] = [{ file: "src/new.ts", kind: "added", insertions: 5, deletions: 0 }];
    const addedHtml = renderLink("src/new.ts", "D:/项目", () => {}, changes);
    expect(addedHtml).toContain('class="is-add">+5</span>');
    expect(addedHtml).not.toContain('class="is-remove"');
    expect(renderLink("src/read.ts", "D:/项目", () => {}, changes)).not.toContain("file-stats");
  });
});

describe("React chat sticker messages", () => {
  it("extracts a persisted user sticker marker and hides the raw marker", () => {
    expect(extractMessageStickerId("[sticker:hugtight]")).toBe("hugtight");
    expect(stripMessageStickerMarkers("[sticker:hugtight]")).toBe("");
  });

  it("keeps user text while removing only its sticker marker", () => {
    expect(stripMessageStickerMarkers("给你一个 [sticker:hugtight]")).toBe("给你一个");
  });
});

describe("formal answer visibility", () => {
  it("attaches transient retry status to the visible waiting state", () => {
    const message: ChatMessageItem = {
      id: "assistant-retrying",
      role: "assistant",
      content: "",
      waitingForFirstEvent: true,
      modelRetry: { phase: "waiting", retryNumber: 2, maxRetries: 5, delayMs: 3000 },
    };

    expect(createMessageItems([message], [])).toMatchObject([{
      role: "waiting",
      extraInfo: { modelRetry: { phase: "waiting", retryNumber: 2, maxRetries: 5, delayMs: 3000 } },
    }]);
  });

  it("keeps an interrupted run in the process area without creating an empty assistant bubble", () => {
    const message: ChatMessageItem = {
      id: "assistant-interrupted",
      role: "assistant",
      content: "",
      responseStarted: false,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0, keepExpanded: true },
      processMessages: [{ id: "process-1", content: "已经检查了文件", afterToolCount: 0 }],
    };

    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["activity"]);
  });

  it("shows transient candidate text in the assistant answer slot without treating it as persisted content", () => {
    const message: ChatMessageItem = {
      id: "assistant-live",
      role: "assistant",
      content: "",
      transientText: "正在实时生成",
      responseStarted: true,
      streaming: true,
    };

    const [item] = createMessageItems([message], []);
    expect(item).toMatchObject({
      role: "assistant",
      content: "正在实时生成",
      extraInfo: { streaming: true },
    });
    expect(message.content).toBe("");
  });

  it("renders both streaming and completed content through the message Markdown renderer", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const liveHtml = renderToStaticMarkup(React.createElement(MarkdownContent, {
      content: "正在生成",
      streaming: true,
    }));
    const completedHtml = renderToStaticMarkup(React.createElement(MarkdownContent, {
      content: "已经完成",
      streaming: false,
    }));

    expect(liveHtml).toContain("正在生成");
    expect(completedHtml).toContain("已经完成");
    expect(liveHtml).toContain("cy-streamdown-message");
    expect(completedHtml).toContain("cy-streamdown-message");
  });

  it("keeps the source free of breathing tails, tail animations and generating hints", () => {
    const source = readFileSync(resolve(__dirname, "ChatMessageList.tsx"), "utf8");
    const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
    expect(source).not.toContain("cy-live-answer");
    expect(source).not.toContain("LiveAnswerTail");
    expect(source).not.toContain("generatingAnswer");
    expect(stylesheet).not.toContain("cy-live-answer");
    expect(stylesheet).not.toContain("cy-live-answer-breathe");
  });

  it("separates assistant Markdown headings from the following body text", () => {
    const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");

    expect(stylesheet).toMatch(/\.cy-message--assistant \.cy-message-markdown h1 \{[^}]*padding-bottom:\s*8px;[^}]*border-bottom:\s*1px solid/s);
    expect(stylesheet).toMatch(/\.cy-message--assistant \.cy-message-markdown h1 \{[^}]*margin:\s*26px 0 16px;/s);
    expect(stylesheet).toMatch(/\.cy-message--assistant \.cy-message-markdown h2 \{[^}]*margin:\s*24px 0 10px;/s);
    expect(stylesheet).toMatch(/\.cy-message--assistant \.cy-message-markdown h3 \{[^}]*margin:\s*20px 0 8px;/s);
  });

  it("hides the run activity card at terminal when the run produced no process content", () => {
    const message: ChatMessageItem = {
      id: "assistant-plain",
      role: "assistant",
      content: "第一轮就没有工具调用，直接是正式回答",
      responseStarted: true,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
    };
    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["assistant"]);
  });

  it("keeps the run activity card while processing even without content yet", () => {
    const message: ChatMessageItem = {
      id: "assistant-starting",
      role: "assistant",
      content: "",
      runActivity: { startedAt: 1, reasoningMs: 0 },
    };
    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["activity"]);
  });

  it("keeps the run activity card at terminal when process content exists", () => {
    const message: ChatMessageItem = {
      id: "assistant-tools",
      role: "assistant",
      content: "最终回答",
      responseStarted: true,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      processMessages: [{ id: "process-1", content: "先看结构", afterToolCount: 0 }],
    };
    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["activity", "assistant"]);
  });

  it("pins one avatar on the run activity card and hides the assistant avatar while the card is visible", () => {
    const message: ChatMessageItem = {
      id: "assistant-tools",
      role: "assistant",
      content: "最终回答",
      responseStarted: true,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      processMessages: [{ id: "process-1", content: "先看结构", afterToolCount: 0 }],
    };
    const items = createMessageItems([message], []);
    const activityItem = items.find((item) => item.role === "activity");
    const assistantItem = items.find((item) => item.role === "assistant");
    // 头像钉在活动卡（运行块头部），一次运行只出现一次
    expect(activityItem?.avatar).toBeTruthy();
    // 运行块内的正文隐藏自己的头像（占位保留，左边缘与时间线内容对齐）
    expect(assistantItem?.rootClassName).toContain("cy-message--assistant-run");
    const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
    expect(stylesheet).toMatch(/\.cy-message--assistant-run \.ant-bubble-avatar \{\s*visibility: hidden/);
    expect(stylesheet).not.toMatch(/\.cy-message--activity \.ant-bubble-avatar \{\s*display: none/);
  });

  it("keeps the assistant avatar when the run activity card is not rendered", () => {
    const message: ChatMessageItem = {
      id: "assistant-plain",
      role: "assistant",
      content: "第一轮就没有工具调用，直接是正式回答",
      responseStarted: true,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
    };
    const [assistantItem] = createMessageItems([message], []);
    // 活动卡未渲染（无过程内容的终态）：正文保留自己的头像，不出现空占位
    expect(assistantItem?.rootClassName ?? "").not.toContain("cy-message--assistant-run");
  });

  it("renders a flat continuous timeline while the run is live, without per-round fold bars", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      live: true,
      agentRounds: [
        { id: "round-0", status: "completed", startedAt: 1, completedAt: 2 },
        { id: "round-1", status: "running", startedAt: 3 },
      ],
      processMessages: [{ id: "process-0", roundId: "round-0", content: "先看项目结构", seq: 1 }],
      reasoningBlocks: [
        { id: "reason-0", roundId: "round-0", content: "思考目录结构", seq: 0 },
        { id: "reason-1", roundId: "round-1", content: "查找 IPC 入口", seq: 3 },
      ],
      tools: [{ id: "tool-0", roundId: "round-0", name: "list_dir", status: "success", seq: 2 }],
      interrupted: false,
    }));

    expect(html).not.toContain("cy-agent-round");
    expect(html).not.toContain("昔涟已完成");
    expect(html).toContain("思考目录结构");
    expect(html).toContain("先看项目结构");
    expect(html).toContain("查找 IPC 入口");
    // 按 seq 连续排序：推理 → 过程正文 → 下一轮推理
    expect(html.indexOf("思考目录结构")).toBeLessThan(html.indexOf("先看项目结构"));
    expect(html.indexOf("先看项目结构")).toBeLessThan(html.indexOf("查找 IPC 入口"));
  });

  it("labels a cancelled candidate as interrupted process content", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-0", status: "running", startedAt: 1 }],
      processMessages: [{ id: "process-0", roundId: "round-0", content: "做到一半", interrupted: true }],
      reasoningBlocks: [],
      tools: [],
      interrupted: true,
    }));

    expect(html).toContain("未完成的生成内容");
    expect(html).toContain("做到一半");
  });
});

describe("interactive tool results stay in tool details", () => {
  const answeredAsk = {
    id: "ask-1", name: "ask_user", status: "success" as const,
    result: "怎么显示背景？ → 居中裁切铺满\n文字怎么处理？ → 半透明底色",
  };

  it("keeps answered questions inside a completed run's collapsed activity", () => {
    const items = createMessageItems([{
      id: "answer", role: "assistant", content: "按你的选择实施。",
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      agentRounds: [{ id: "round-ask", status: "completed", startedAt: 1, completedAt: 2 }],
      toolExecutions: [{ ...answeredAsk, roundId: "round-ask" }],
    }], []);

    expect(items.map((item) => item.role)).toEqual(["activity", "assistant"]);
    expect(items[0]).toMatchObject({
      extraInfo: { tools: [{ id: "ask-1", result: "怎么显示背景？ → 居中裁切铺满\n文字怎么处理？ → 半透明底色" }] },
    });
  });

  it("preserves narration and other tools on each side of an answered question", () => {
    const items = createMessageItems([{
      id: "mixed", role: "assistant", content: "完成。",
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      processMessages: [
        { id: "before", content: "需要你选一下", seq: 1 },
        { id: "after", content: "按选择修改", seq: 4 },
      ],
      toolExecutions: [
        { id: "read", name: "read_file", status: "success", seq: 2 },
        { ...answeredAsk, seq: 3 },
        { id: "edit", name: "str_replace", status: "success", seq: 5 },
      ],
    }], []);

    expect(items.map((item) => item.role)).toEqual(["activity", "assistant"]);
    expect(items[0].extraInfo).toMatchObject({
      processMessages: [{ id: "before" }, { id: "after" }],
      tools: [{ id: "read" }, { id: "ask-1" }, { id: "edit" }],
    });
    expect(buildFlatRunTimeline(items[0].extraInfo as Parameters<typeof buildFlatRunTimeline>[0]).map((entry) => entry.key))
      .toEqual(["before", "read", "ask-1", "after", "edit"]);
  });

  it("preserves historical ordering when records only have afterToolCount", () => {
    const items = createMessageItems([{
      id: "history", role: "assistant", content: "",
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      processMessages: [
        { id: "before", content: "先确认", afterToolCount: 0 },
        { id: "after", content: "收到答案", afterToolCount: 1 },
      ],
      toolExecutions: [answeredAsk],
    }], []);

    expect(items.map((item) => item.role)).toEqual(["activity"]);
    expect(items[0].extraInfo).toMatchObject({
      processMessages: [{ id: "before", afterToolCount: 0 }, { id: "after", afterToolCount: 1 }],
      tools: [{ id: "ask-1" }],
    });
  });

  it("keeps answered questions in a tool card for older messages without run activity", () => {
    const items = createMessageItems([{
      id: "legacy", role: "assistant", content: "", toolExecutions: [answeredAsk],
    }], []);
    expect(items.map((item) => item.role)).toEqual(["tool"]);
    expect(items[0].extraInfo).toMatchObject({ tools: [{ id: "ask-1", result: answeredAsk.result }] });
  });

  it.each(["running", "error", "success"] as const)("keeps %s questions on the existing tool path", (status) => {
    const items = createMessageItems([{
      id: "pending", role: "assistant", content: "",
      runActivity: { startedAt: 1, reasoningMs: 0 },
      toolExecutions: [{ ...answeredAsk, status }],
    }], []);
    expect(items.map((item) => item.role)).toEqual(["activity"]);
    expect(items[0].extraInfo).toMatchObject({ tools: [{ id: "ask-1", status }] });
  });

  it("keeps quiz answers and grading in the activity alongside other tool details", () => {
    const result = JSON.stringify({ status: "submitted", results: [{ question: "测试题", userAnswer: "A", grading: "correct" }] });
    const items = createMessageItems([{
      id: "quiz", role: "assistant", content: "讲评正文。",
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0 },
      toolExecutions: [
        answeredAsk,
        { id: "quiz-1", name: "pop_quiz", displayName: "突击抽查", status: "success", result },
      ],
    }], []);
    expect(items.map((item) => item.role)).toEqual(["activity", "assistant"]);
    expect(items[0].extraInfo).toMatchObject({ tools: [{ id: "ask-1", result: answeredAsk.result }, { id: "quiz-1", result }] });
    expect(items[1].content).toBe("讲评正文。");
  });

  it("retains unrecognized results instead of silently removing the tool", () => {
    const items = createMessageItems([{
      id: "unknown", role: "assistant", content: "",
      toolExecutions: [{ ...answeredAsk, result: "用户取消了问题" }],
    }], []);
    expect(items.map((item) => item.role)).toEqual(["tool"]);
  });

  it("renders repeated answers as numbered text and escapes user-provided markup", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(AskUserQaContent, {
      rows: ["下一步？ → <script>不执行</script> → 保留箭头", "下一步？ → <script>不执行</script> → 保留箭头"],
    }));
    expect(html).toContain("<ol");
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.match(/>Q:<\/span>/g)).toHaveLength(2);
    expect(html.match(/>A:<\/span>/g)).toHaveLength(2);
    expect(html).toContain("&lt;script&gt;不执行&lt;/script&gt; → 保留箭头");
    expect(html).not.toContain("<script>");
  });
});

describe("bound channel message presentation", () => {
  it("shows a sender only for group messages instead of repeating channel status", () => {
    expect(formatChannelSourceLabel({ channel: "wechat", chatType: "group", senderName: "伙伴" }, "incoming")).toBe("伙伴");
    expect(formatChannelSourceLabel({ channel: "wechat", chatType: "private", senderName: "伙伴" }, "incoming")).toBe("");
    expect(formatChannelSourceLabel({ channel: "qq", senderName: "旧消息昵称" }, "incoming")).toBe("");
    expect(formatChannelSourceLabel({ channel: "qq" }, "outgoing")).toBe("");
  });

  it("falls back safely when persisted channel metadata is invalid", () => {
    expect(formatChannelSourceLabel({ channel: "unknown" } as never, "incoming")).toBe("");
  });

  it("summarizes channel context once for the whole conversation", () => {
    expect(resolveChannelConversationLabel([
      { id: "u1", role: "user", content: "微信消息", channelSource: { channel: "wechat" } },
      { id: "a1", role: "assistant", content: "回复", channelSource: { channel: "wechat" } },
    ])).toBe("微信 · 同一对话");

    expect(resolveChannelConversationLabel([
      { id: "u1", role: "user", content: "微信消息", channelSource: { channel: "wechat" } },
      { id: "u2", role: "user", content: "QQ消息", channelSource: { channel: "qq" } },
    ])).toBe("微信、QQ · 同一对话");

    expect(resolveChannelConversationLabel([
      { id: "u1", role: "user", content: "普通消息" },
    ])).toBeNull();
  });

  it("keeps the visible text clean and carries channel source metadata to the bubble", () => {
    const message = {
      id: "wechat-user",
      role: "user",
      content: "下午见",
      channelSource: { channel: "wechat", chatType: "group", senderName: "伙伴" },
    } as ChatMessageItem;

    const [item] = createMessageItems([message], []);

    expect(item.content).toBe("下午见");
    expect(item.extraInfo?.channelSource).toEqual({ channel: "wechat", chatType: "group", senderName: "伙伴" });
  });
});

describe("compaction marker presentation", () => {
  it("converts a compaction marker into a single separator bubble entry", () => {
    const message: ChatMessageItem = {
      id: "checkpoint-1",
      role: "assistant",
      content: "",
      compaction: { trigger: "manual" },
    };
    expect(createMessageItems([message], [])).toEqual([{
      key: "checkpoint-1",
      role: "compaction",
      content: "",
      extraInfo: {},
    }]);
  });
});

describe("review panel visibility", () => {
  it("appends a review bubble when runId is set and message is not streaming", () => {
    const message: ChatMessageItem = {
      id: "assistant-done",
      role: "assistant",
      content: "完成了",
      streaming: false,
      runId: "run-abc-123",
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).toContain("review");
    const reviewItem = createMessageItems([message], []).find((item) => item.role === "review");
    expect(reviewItem?.extraInfo?.runId).toBe("run-abc-123");
    // Review 面板属于运行块：头像占位隐藏，面板与正文/时间线内容左对齐
    expect(reviewItem?.rootClassName).toContain("cy-message--review-run");
    expect(reviewItem?.avatar).toBeTruthy();
    const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
    expect(stylesheet).toMatch(/\.cy-message--review-run \.ant-bubble-avatar \{\s*display: block;\s*visibility: hidden/);
    expect(stylesheet).toMatch(/\.cy-message--review-run \.ant-bubble-body \{[\s\S]*width: calc\(100% - 54px\)/);
  });

  it("does not append review bubble while streaming", () => {
    const message: ChatMessageItem = {
      id: "assistant-streaming",
      role: "assistant",
      content: "正在处理",
      streaming: true,
      runId: "run-abc-456",
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).not.toContain("review");
  });

  it("does not append review bubble when runId is absent", () => {
    const message: ChatMessageItem = {
      id: "assistant-no-run",
      role: "assistant",
      content: "纯对话",
      streaming: false,
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).not.toContain("review");
  });
});

describe("function-calling round presentation", () => {
  it("renders one collapsible activity group per model round with reasoning inside", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [
        { id: "round-0", status: "completed", startedAt: 1, completedAt: 2 },
        { id: "round-1", status: "running", startedAt: 3 },
      ],
      processMessages: [
        { id: "process-0", roundId: "round-0", content: "先看项目结构" },
        { id: "process-1", roundId: "round-1", content: "继续检查取消链路" },
      ],
      reasoningBlocks: [
        { id: "reason-0", roundId: "round-1", content: "已经理清目录结构", streaming: false },
        { id: "reason-1", roundId: "round-1", content: "查找 IPC 入口", streaming: true },
      ],
      tools: [
        { id: "tool-0", roundId: "round-0", name: "list_dir", status: "success" },
        { id: "tool-1", roundId: "round-1", name: "read_file", status: "running" },
      ],
      interrupted: false,
    }));

    expect(html.match(/class="cy-agent-round(?: is-(?:running|complete))?"/g)).toHaveLength(2);
    expect(html.match(/class="cy-agent-round__art"/g)).toHaveLength(2);
    expect(html.match(/class="cy-agent-round__art-image"/g)).toHaveLength(2);
    expect(html).not.toContain("cy-agent-round__status");
    expect(html).toContain("cy-reasoning-status-art is-thinking");
    const thinkingArt = html.match(/cy-reasoning-status-art is-thinking[^>]*><img src="([^"]+)"/)?.[1];
    const completedArt = html.match(/cy-reasoning-status-art is-complete[^>]*><img src="([^"]+)"/)?.[1];
    expect(thinkingArt).toContain(encodeURIComponent("思考中.png"));
    expect(completedArt).toContain(encodeURIComponent("提醒.png"));
    expect(html).toContain("昔涟已完成 · 浏览 1 个目录");
    expect(html).toContain("昔涟正在读取文件");
    expect(html).toContain("先看项目结构");
    expect(html).toContain("继续检查取消链路");
    expect(html).toContain("查找 IPC 入口");
  });

  it("appends a pink changed-files hint after the completed round title", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-0", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [],
      reasoningBlocks: [],
      tools: [{
        id: "tool-0", roundId: "round-0", name: "str_replace", status: "success",
        changes: [{ file: "src/a.ts", kind: "modified", insertions: 3, deletions: 1 }],
      }],
      interrupted: false,
    }));

    expect(html).toContain("昔涟已完成");
    expect(html).toContain('class="cy-agent-round__files"');
    expect(html).toContain("1 个文件已被改动");
  });

  it("does not render an empty final-answer round as a fake completed operation", async () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-final", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [],
      reasoningBlocks: [],
      tools: [],
      interrupted: false,
    }));
    expect(html).not.toContain("cy-agent-round");
  });

  it("keeps function-calling narration visible after its round collapses", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-complete", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [{ id: "process-complete", roundId: "round-complete", content: "人家先去看一眼目录结构" }],
      reasoningBlocks: [],
      tools: [{ id: "tool-complete", roundId: "round-complete", name: "list_dir", status: "success" }],
      interrupted: false,
    }));

    expect(html).toContain("人家先去看一眼目录结构");
  });

  it("renders a task delegation in its owning tool round", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-task", status: "running", startedAt: 1 }],
      processMessages: [],
      reasoningBlocks: [],
      taskDelegations: [{
        invocationId: "child-run-1",
        taskId: "task-1",
        description: "检查取消链路",
        nickname: "风堇",
        assetFileName: "风堇.png",
        status: "running",
        roundId: "round-task",
      }],
      tools: [],
      interrupted: false,
    }));

    expect(html).toContain("昔涟委托了");
    expect(html).toContain("风堇");
    expect(html).toContain("检查取消链路");
  });
});

describe("阶段 2：单消息派生缓存（assembleMessageItems）", () => {
  it("消息对象不变时命中缓存：条目引用稳定，items 外层数组每次新建", () => {
    const user: ChatMessageItem = { id: "user-a", role: "user", content: "请求" };
    const assistant: ChatMessageItem = { id: "assistant-a", role: "assistant", content: "回答" };
    // 贴纸表引用需稳定（组件内来自 useState），字面量每次新建会导致缓存永远失效
    const stickers: EnabledSticker[] = [];
    const first = assembleMessageItems([user, assistant], stickers, null);
    const second = assembleMessageItems([user, assistant], stickers, first.cache);

    // 外层数组每次新建（驱动列表渲染），但条目对象复用：历史气泡的 memoized content 不失效
    expect(second.items).not.toBe(first.items);
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).toBe(first.items[1]);
  });

  it("patch 产生新消息对象时只重算该消息的条目，其余条目引用不变", () => {
    const user: ChatMessageItem = { id: "user-a", role: "user", content: "请求" };
    const assistant: ChatMessageItem = { id: "assistant-a", role: "assistant", content: "半" };
    const stickers: EnabledSticker[] = [];
    const first = assembleMessageItems([user, assistant], stickers, null);
    // 模拟流式 delta：patchSessionMessage 只替换目标消息对象，其余消息引用保持
    const patchedAssistant: ChatMessageItem = { ...assistant, content: "完整回答" };
    const second = assembleMessageItems([user, patchedAssistant], stickers, first.cache);

    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).not.toBe(first.items[1]);
    expect(second.items[1].content).toBe("完整回答");
  });

  it("stickers 引用变化时缓存整体失效：全部消息重算并取到新贴纸地址", () => {
    const user: ChatMessageItem = { id: "user-a", role: "user", content: "[sticker:hugtight]" };
    const stickers = [{ id: "hugtight", src: "https://example.com/hugtight.png" }];
    const first = assembleMessageItems([user], stickers, null);
    // 同一 stickers 引用：命中缓存
    const second = assembleMessageItems([user], stickers, first.cache);
    expect(second.items[0]).toBe(first.items[0]);
    // stickers 引用变化：整体换新 WeakMap，消息即使引用未变也重算
    const changedStickers = [{ id: "hugtight", src: "https://example.com/v2.png" }];
    const third = assembleMessageItems([user], changedStickers, second.cache);
    expect(third.items[0]).not.toBe(first.items[0]);
    expect(third.items[0].extraInfo?.stickerUrl).toBe("https://example.com/v2.png");
  });

  it("多条目顺序稳定：reasoning、正文、review 依次排列且缓存前后一致", () => {
    const assistant: ChatMessageItem = {
      id: "assistant-multi",
      role: "assistant",
      content: "最终回答",
      reasoningBlocks: [{ id: "r1", content: "思考", streaming: false }],
      runId: "run-a",
    };
    const stickers: EnabledSticker[] = [];
    const first = assembleMessageItems([assistant], stickers, null);
    expect(first.items.map((item) => item.key)).toEqual([
      "assistant-multi-reasoning-r1",
      "assistant-multi",
      "assistant-multi-review",
    ]);

    const second = assembleMessageItems([assistant], stickers, first.cache);
    expect(second.items.map((item) => item.key)).toEqual(first.items.map((item) => item.key));
    expect(second.items.every((item, index) => item === first.items[index])).toBe(true);
  });
});
