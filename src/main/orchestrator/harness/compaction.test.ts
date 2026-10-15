import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../vendors/types";
import {
  computeTokenBudget,
  compressForAgentLoop,
  findSafeCutPointForRetainedTokens,
  isToolPairSafeBoundary,
} from "./compaction";

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("compaction trigger budget", () => {
  it.each([
    { tokens: 217_599, expected: false },
    { tokens: 217_600, expected: true },
  ])("256K 上下文在 $tokens 个词元时压缩判定为 $expected", ({ tokens, expected }) => {
    // 英文内容按 4 字符/词元，加上消息格式的 4 个词元。
    const messages = [message("user", "a".repeat((tokens - 4) * 4))];
    const budget = computeTokenBudget("", [], messages, 256_000, 8_192, 512);

    expect(budget.estimatedInput).toBe(tokens);
    expect(budget.needsCompaction).toBe(expected);
  });

  it("小窗口输入挤占输出预留时仍触发安全压缩", () => {
    const messages = [message("user", "a".repeat((1_296 - 4) * 4))];
    const budget = computeTokenBudget("", [], messages, 10_000, 8_192, 512);

    expect(budget.needsCompaction).toBe(true);
  });
});

describe("Harness context compaction v2", () => {
  it("keeps a tool call and its result in the retained token-budgeted tail", () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务"),
      {
        role: "assistant",
        content: "我先读取文件。",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-read", name: "read_file", content: "文件内容".repeat(30) },
      message("user", "请根据结果继续".repeat(20)),
    ];

    const cutIndex = findSafeCutPointForRetainedTokens(messages, 100);

    expect(cutIndex).toBe(1);
    expect(messages.slice(cutIndex).map((entry) => entry.role)).toEqual([
      "assistant", "tool", "user",
    ]);
  });

  it("cannot split an assistant with two tool calls and only one result", () => {
    const messages: ChatMessage[] = [
      message("user", "查询"),
      {
        role: "assistant",
        content: "并行读取两个文件。",
        toolCalls: [
          { id: "call-a", name: "read_file", arguments: "{}" },
          { id: "call-b", name: "read_file", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "call-a", name: "read_file", content: "文件 A 内容" },
    ];

    // 声明与已有结果之间不得切开（结果在右、声明在左 → 跨界）
    expect(isToolPairSafeBoundary(messages, 2)).toBe(false);
    // 声明之前切开：整组（声明 + 结果）保留在右侧 → 安全
    expect(isToolPairSafeBoundary(messages, 1)).toBe(true);
    // 全部保留 → 安全
    expect(isToolPairSafeBoundary(messages, 0)).toBe(true);
  });

  it("keeps the original transcript when summary generation fails", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => { throw new Error("summary unavailable"); },
    });

    expect(result).toBe(messages);
  });

  it("keeps the original transcript when the summary is not smaller", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => "摘要".repeat(200),
    });

    expect(result).toBe(messages);
  });
});
