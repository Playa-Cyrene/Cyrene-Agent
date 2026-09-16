import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import {
  applyAgentRoundBoundary,
  buildAskUserQa,
  buildFlatRunTimeline,
  countRoundChangedFiles,
  createRoundProcessMessage,
  describeToolExecution,
  finishAgentRound,
  resolveAgentRoundTitle,
  startAgentRound,
} from "./agent-rounds";

function tool(
  id: string,
  name: string,
  status: ToolExecutionRecord["status"] = "success",
): ToolExecutionRecord {
  return { id, name, status, roundId: "round-0" };
}

describe("agent round presentation", () => {
  it("keeps terminal error text attached to the interrupted active round", () => {
    expect(createRoundProcessMessage("error-1", "模型请求失败", 3, "round-2")).toEqual({
      id: "error-1",
      content: "模型请求失败",
      afterToolCount: 3,
      roundId: "round-2",
    });
  });

  it("tracks the active round from ordered start and end events", () => {
    const started = applyAgentRoundBoundary({ rounds: [], activeRoundId: undefined }, "start", "round-0", 100);
    expect(started).toEqual({
      rounds: [{ id: "round-0", status: "running", startedAt: 100 }],
      activeRoundId: "round-0",
    });

    expect(applyAgentRoundBoundary(started, "end", "round-0", 250)).toEqual({
      rounds: [{ id: "round-0", status: "completed", startedAt: 100, completedAt: 250 }],
      activeRoundId: undefined,
    });
  });

  it("starts and finishes a stable model round", () => {
    const started = startAgentRound([], "round-0", 100);
    expect(started).toEqual([{ id: "round-0", status: "running", startedAt: 100 }]);

    expect(finishAgentRound(started, "round-0", 250)).toEqual([
      { id: "round-0", status: "completed", startedAt: 100, completedAt: 250 },
    ]);
  });

  it("uses the currently running tool as the live title", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "list_dir", "success"),
      tool("b", "read_file", "running"),
    ])).toBe("昔涟正在读取文件");
  });

  it("describes a running shell call with its exact command", () => {
    expect(describeToolExecution({
      id: "shell-1",
      name: "run_shell",
      status: "running",
      argsText: JSON.stringify({ command: "npm run test -- agent-rounds" }),
    })).toEqual({
      label: "运行命令",
      statusText: "正在运行命令",
      detail: "npm run test -- agent-rounds",
    });
  });

  it("describes a file write by its target path without exposing file contents", () => {
    expect(describeToolExecution({
      id: "write-1",
      name: "write_file",
      status: "running",
      argsText: JSON.stringify({ path: "src/renderer/App.tsx", content: "secret source" }),
    })).toEqual({
      label: "写入文件",
      statusText: "正在写入文件",
      detail: "src/renderer/App.tsx",
    });
  });

  it("keeps the activity useful when streamed arguments are malformed", () => {
    expect(describeToolExecution({
      id: "shell-2",
      name: "run_shell",
      status: "running",
      argsText: "{\"command\":",
    })).toEqual({
      label: "运行命令",
      statusText: "正在运行命令",
      detail: undefined,
    });
  });

  it("distinguishes a timed-out shell command from a generic execution failure", () => {
    expect(describeToolExecution({
      id: "shell-timeout",
      name: "run_shell",
      status: "error",
      argsText: JSON.stringify({ command: "npx serve . -l 3456" }),
      result: JSON.stringify({ timedOut: true, exitCode: null }),
    })).toEqual({
      label: "运行命令",
      statusText: "命令运行超时",
      detail: "npx serve . -l 3456",
    });
  });

  it("summarizes only truthful successful tool facts and reports failures", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      ...Array.from({ length: 5 }, (_, index) => tool(`dir-${index}`, "list_dir")),
      tool("read-1", "read_file"),
      tool("read-2", "read_file"),
      tool("read-failed", "read_file", "error"),
    ])).toBe("昔涟已完成 · 浏览 5 个目录 · 读取 2 个文件 · 1 项失败");
  });

  it("falls back to an operation count for tools without a semantic summary", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "custom_a"),
      tool("b", "custom_b"),
    ])).toBe("昔涟已完成 · 完成 2 项操作");
  });

  it("keeps an interrupted round honest instead of claiming completion", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [tool("a", "read_file", "error")], true))
      .toBe("昔涟已中断 · 1 项失败");
  });

  it("prefers the registry display name over the i18n mapping and raw id", () => {
    const record: ToolExecutionRecord = {
      id: "play-1",
      name: "music_play_track",
      displayName: "播放歌曲",
      status: "running",
    };
    expect(describeToolExecution(record)).toEqual({
      label: "播放歌曲",
      statusText: "正在播放歌曲",
      detail: undefined,
    });
  });

  it("falls back to the i18n mapping for records without a display name", () => {
    expect(describeToolExecution({
      id: "read-legacy",
      name: "read_file",
      status: "success",
    })).toEqual({
      label: "读取文件",
      statusText: "读取文件完成",
      detail: undefined,
    });
  });

  it("shows the raw tool id when neither display name nor mapping exists", () => {
    expect(describeToolExecution({
      id: "unknown-1",
      name: "music_play_track",
      status: "success",
    })).toEqual({
      label: "music_play_track",
      statusText: "执行操作完成",
      detail: undefined,
    });
  });

  it("describes an ask_user call with waiting and answered states", () => {
    expect(describeToolExecution({
      id: "ask-1",
      name: "ask_user",
      status: "running",
    })).toEqual({
      label: "询问用户",
      statusText: "等待用户回答",
      detail: undefined,
    });
    expect(describeToolExecution({
      id: "ask-1",
      name: "ask_user",
      status: "success",
    })).toEqual({
      label: "询问用户",
      statusText: "用户已回答",
      detail: undefined,
    });
    expect(describeToolExecution({
      id: "ask-1",
      name: "ask_user",
      status: "error",
    })).toEqual({
      label: "询问用户",
      statusText: "询问用户失败",
      detail: undefined,
    });
  });
});

describe("buildAskUserQa", () => {
  it("splits an ask_user tool result into readable question rows", () => {
    expect(buildAskUserQa({
      id: "ask-1",
      name: "ask_user",
      status: "success",
      result: "使用哪个数据库？ → PostgreSQL\n部署到哪个环境？ → 测试环境",
    })).toEqual([
      "使用哪个数据库？ → PostgreSQL",
      "部署到哪个环境？ → 测试环境",
    ]);
  });

  it("returns no rows for empty or non-ask results", () => {
    expect(buildAskUserQa({ id: "ask-1", name: "ask_user", status: "running" })).toEqual([]);
    expect(buildAskUserQa({ id: "t-1", name: "list_dir", status: "success", result: "src" })).toEqual([]);
  });
});

describe("buildFlatRunTimeline", () => {
  it("interleaves reasoning, process text and tools by seq across categories", () => {
    const entries = buildFlatRunTimeline({
      processMessages: [
        { id: "p-0", content: "先看结构", seq: 1 },
        { id: "p-1", content: "继续检查", seq: 4 },
      ],
      reasoningBlocks: [
        { id: "r-0", content: "思考目录", seq: 0 },
        { id: "r-1", content: "查找入口", seq: 3 },
      ],
      tools: [{ id: "t-0", name: "list_dir", status: "success", seq: 2 }],
      taskDelegations: [],
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "reasoning", "process", "tool", "reasoning", "process",
    ]);
    expect(entries.map((entry) => entry.key)).toEqual(["r-0", "p-0", "t-0", "r-1", "p-1"]);
  });

  it("falls back to afterToolCount ordering for legacy records without seq", () => {
    const entries = buildFlatRunTimeline({
      processMessages: [
        { id: "p-0", content: "第一段正文", afterToolCount: 0 },
        { id: "p-1", content: "第二段正文", afterToolCount: 1 },
      ],
      reasoningBlocks: [{ id: "r-0", content: "思考", afterToolCount: 0 }],
      tools: [
        { id: "t-0", name: "list_dir", status: "success" },
        { id: "t-1", name: "read_file", status: "success" },
      ],
      taskDelegations: [],
    });

    // 旧记录回退：正文 → 推理 → 工具0 → 正文 → 工具1（沿用既有 afterToolCount 顺序）
    expect(entries.map((entry) => entry.key)).toEqual(["p-0", "r-0", "t-0", "p-1", "t-1"]);
  });

  it("keeps parallel tool calls in their original order", () => {
    const entries = buildFlatRunTimeline({
      processMessages: [{ id: "p-0", content: "正文", seq: 0 }],
      reasoningBlocks: [],
      tools: [
        { id: "t-a", name: "read_file", status: "success", seq: 1 },
        { id: "t-b", name: "read_file", status: "success", seq: 2 },
      ],
      taskDelegations: [],
    });

    expect(entries.map((entry) => entry.key)).toEqual(["p-0", "t-a", "t-b"]);
  });
});

describe("countRoundChangedFiles", () => {
  it("counts changed files deduplicated by path across tools", () => {
    const tools: ToolExecutionRecord[] = [
      {
        id: "a", name: "str_replace", status: "success", roundId: "round-0",
        changes: [{ file: "src/a.ts", kind: "modified", insertions: 1, deletions: 1 }],
      },
      {
        id: "b", name: "write_file", status: "success", roundId: "round-0",
        changes: [
          { file: "src/a.ts", kind: "modified", insertions: 2, deletions: 0 },
          { file: "src/b.ts", kind: "added", insertions: 5, deletions: 0 },
        ],
      },
      { id: "c", name: "read_file", status: "success", roundId: "round-0" },
    ];
    expect(countRoundChangedFiles(tools)).toBe(2);
  });

  it("returns 0 when no tool reports changes", () => {
    expect(countRoundChangedFiles([tool("a", "list_dir")])).toBe(0);
    expect(countRoundChangedFiles([])).toBe(0);
  });
});
