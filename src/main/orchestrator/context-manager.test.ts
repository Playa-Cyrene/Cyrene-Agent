import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateMessageContentTokens,
  estimateMessageTokens,
} from "./context-manager";

// 不调用真实 API：以 SDK 请求使用的投影规则覆盖工具与私有重放边界。
import type { ChatMessage, ModelMessageOrigin } from "./vendors/types";
import { estimateTokens } from "./context-manager";
import { buildContextUsageSnapshot, buildCompactionContextUsageSnapshot } from "./context-usage";
import { computeTokenBudget, findSafeCutPointForRetainedTokens } from "./harness/compaction";


describe("estimateMessageContentTokens — 图片块计量口径（known-issues 问题 2）", () => {
  it("字符串内容按文本估算", () => {
    expect(estimateMessageContentTokens("你好")).toBeGreaterThan(0);
  });

  it("空块数组返回 0", () => {
    expect(estimateMessageContentTokens([])).toBe(0);
  });

  it("text 块按文本估算，与字符串口径一致", () => {
    const text = "一段普通文本";
    expect(estimateMessageContentTokens([{ type: "text", text }]))
      .toBe(estimateMessageContentTokens(text));
  });

  it("image_url 块按固定值估算，不计 base64 全长", () => {
    const hugeBase64 = `data:image/png;base64,${"A".repeat(1_000_000)}`;
    const tokens = estimateMessageContentTokens([
      { type: "image_url", image_url: { url: hugeBase64 } },
    ]);
    // 虚高修复前：base64 长度会被整串计入（百万字符 → 数十万 token）。
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it("混合块 = 文本估算 + 图片固定值", () => {
    const text = "看这张图";
    const tokens = estimateMessageContentTokens([
      { type: "text", text },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
    expect(tokens).toBe(estimateMessageContentTokens(text) + DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it("多图消息按图片张数线性累计", () => {
    const tokens = estimateMessageContentTokens([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
    ]);
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE * 2);
  });
});

describe("estimateMessageTokens — 消息级计量复用同一口径", () => {
  it("图片消息不因 base64 长度爆炸（角色开销 +4 之外只有固定图片估算）", () => {
    const tokens = estimateMessageTokens([
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(500_000)}` } }] },
    ]);
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE + 4);
  });
});

const origin: ModelMessageOrigin = {
  transport: "openai", provider: "deepseek", model: "test-model", endpoint: "endpoint-digest", credentialScope: "scope-digest",
};
function replayMessage(): ChatMessage {
  return {
    role: "assistant", content: "done", thinking: "display-copy".repeat(10000),
    toolCalls: [{ id: "call_1", name: "write_file", arguments: JSON.stringify({ content: "a".repeat(4000) }) }],
    providerReplay: { version: 1, origin, content: [
      { type: "reasoning", text: "r".repeat(8000), providerOptions: { anthropic: { signature: "s".repeat(400) } } },
      { type: "text", text: "stale text".repeat(10000) },
      { type: "tool-call", toolCallId: "call_1", toolName: "old_name", input: { content: "stale".repeat(10000) } },
    ] },
  };
}
const portableTokens = 4 + estimateTokens("done")
  + estimateTokens("call_1" + "write_file" + JSON.stringify({ content: "a".repeat(4000) }));
const privateTokens = estimateTokens("r".repeat(8000))
  + estimateTokens(JSON.stringify({ anthropic: { signature: "s".repeat(400) } }));

describe("请求投影预算（Related #263）", () => {
  it("工具参数与合格重放计入一次，展示副本及被替换的旧正文/参数不计入", () => {
    const message = replayMessage();
    const before = structuredClone(message);
    expect(estimateMessageTokens([message], origin)).toBe(portableTokens + privateTokens);
    expect(estimateMessageTokens([message])).toBe(portableTokens);
    expect(message).toEqual(before);
  });

  it.each([
    { transport: "anthropic" as const }, { provider: "other" }, { model: "other" },
    { endpoint: "other" }, { credentialScope: "other" },
  ])("切换来源 %j 后仅统计可移植正文及工具，不重放私有 reasoning", (change) => {
    expect(estimateMessageTokens([replayMessage()], { ...origin, ...change })).toBe(portableTokens);
  });

  it("无效 replay 不统计，也不回退展示 thinking", () => {
    const message = replayMessage();
    message.providerReplay!.content = [{ type: "reasoning", text: 123 }] as never;
    expect(estimateMessageTokens([message], origin)).toBe(portableTokens);
  });

  it("旧版 DeepSeek thinking 仅在实际投影恢复时计入", () => {
    const message: ChatMessage = { role: "assistant", content: "done", thinking: "r".repeat(8000) };
    expect(estimateMessageTokens([message], origin)).toBe(2005);
    expect(estimateMessageTokens([message], { ...origin, provider: "other" })).toBe(5);
    expect(estimateMessageTokens([{ ...message, rawAssistant: [] }], origin)).toBe(5);
    expect(estimateMessageTokens([{ ...message, content: "" }], origin)).toBe(0);
  });

  it("legacy rawAssistant 的可移植工具参数也计入，不累计签名及展示思考", () => {
    const message: ChatMessage = { role: "assistant", rawAssistant: [
      { type: "function_call", call_id: "call_1", name: "write_file", arguments: JSON.stringify({ content: "a".repeat(4000) }) },
    ], thinking: "ignored".repeat(10000) };
    expect(estimateMessageTokens([message], origin)).toBe(portableTokens - estimateTokens("done"));
  });

  it("工具+reasoning 可触发压缩；快照/压缩后快照与预算使用同一来源和计量", () => {
    const messages = [replayMessage(), { role: "tool" as const, toolCallId: "call_1", content: "ok" }];
    const budget = computeTokenBudget("", [], messages, 4000, 500, 100, 0.75, origin);
    expect(budget.estimatedInput).toBe(portableTokens + privateTokens + 5);
    expect(budget.needsCompaction).toBe(true);
    expect(computeTokenBudget("", [], messages, 4000, 500, 100, 0.75, { ...origin, model: "other" }).needsCompaction).toBe(false);
    const snapshot = buildContextUsageSnapshot({ phase: "preRequest", personaContent: "", contextWindowTokens: 4000, messages, messageOrigin: origin });
    expect(snapshot.totalTokens).toBe(budget.estimatedInput);
    expect(snapshot.categories.find(c => c.key === "conversation")?.tokens).toBe(portableTokens + privateTokens);
    expect(snapshot.categories.find(c => c.key === "runtimeAndToolLogs")?.tokens).toBe(5);
    expect(buildCompactionContextUsageSnapshot({ phase: "preCompaction", contextWindowTokens: 4000, messages, messageOrigin: origin }).totalTokens).toBe(budget.estimatedInput);
  });

  it("输出预留只改变可用输入/压缩触发，不冒充输入用量或输出上限", () => {
    const messages = [replayMessage()];
    const low = computeTokenBudget("", [], messages, 5000, 500, 100, 0.85, origin);
    const high = computeTokenBudget("", [], messages, 5000, 2500, 100, 0.85, origin);
    expect(low.estimatedInput).toBe(high.estimatedInput);
    expect(low.usableInputBudget).toBe(4400);
    expect(high.usableInputBudget).toBe(2400);
    expect(low.needsCompaction).toBe(false);
    expect(high.needsCompaction).toBe(true);
  });

  it("保留尾部按合格重放占用决定安全切点", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "old" }, replayMessage(),
      { role: "tool", toolCallId: "call_1", content: "ok" }, { role: "user", content: "next" }];
    expect(findSafeCutPointForRetainedTokens(messages, 2000, origin)).toBe(1);
    expect(findSafeCutPointForRetainedTokens(messages, 2000, { ...origin, model: "other" })).toBe(0);
  });
});
