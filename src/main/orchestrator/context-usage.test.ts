import { describe, expect, it } from "vitest";
import { buildCompactionContextUsageSnapshot, buildContextUsageSnapshot } from "./context-usage";
import { isContextUsageSnapshot } from "../../shared/context-usage";
import { buildCompactionCheckpoint } from "./harness/compaction";
import { estimateTokens } from "./context-manager";
import type { ChatMessage } from "./vendors/types";

const WINDOW = 128_000;

it("压缩阶段快照保留系统与工具占用，并支持当前模型容量和新阶段", () => {
  const previous = buildContextUsageSnapshot({
    phase: "preRequest", contextWindowTokens: 256_000, personaContent: "系统规则",
    toolLayerContent: "工具规则", skillLayerContent: "技能", messages: [],
  });
  const next = buildCompactionContextUsageSnapshot({
    phase: "preCompaction", contextWindowTokens: WINDOW, previous,
    messages: [{ role: "user", content: "新的历史" }],
  });
  for (const key of ["systemPrompt", "tools", "skills"] as const) {
    expect(next.categories.find((category) => category.key === key)?.tokens)
      .toBe(previous.categories.find((category) => category.key === key)?.tokens);
  }
  expect(next.contextWindowTokens).toBe(WINDOW);
  expect(isContextUsageSnapshot(next)).toBe(true);
  expect(next.totalTokens).toBe(next.categories.reduce((sum, category) => sum + category.tokens, 0));
});

function snapshotOf(messages: ChatMessage[], overrides: Partial<Parameters<typeof buildContextUsageSnapshot>[0]> = {}) {
  return buildContextUsageSnapshot({
    phase: "preRequest",
    contextWindowTokens: WINDOW,
    personaContent: "你是昔涟。",
    messages,
    ...overrides,
  });
}

function tokensOf(
  snapshot: ReturnType<typeof snapshotOf>,
  key: string,
): number {
  return snapshot.categories.find((category) => category.key === key)?.tokens ?? -1;
}

describe("buildContextUsageSnapshot", () => {
  it("五类基础归类：internal/tool/checkpoint/普通对话/开销兜底", () => {
    const snapshot = snapshotOf([
      { role: "user", content: "你好，帮我看看天气" },
      { role: "assistant", content: "好的，我来查一下" },
      { role: "tool", toolCallId: "call-1", name: "weather", content: "晴" },
      { role: "user", content: "运行时事实", visibility: "internal" },
      buildCompactionCheckpoint("早前对话的摘要"),
    ]);

    expect(tokensOf(snapshot, "systemPrompt")).toBe(estimateTokens("你是昔涟。"));
    expect(tokensOf(snapshot, "runtimeAndToolLogs")).toBe(
      estimateTokens("晴") + 4 + estimateTokens("运行时事实") + 4,
    );
    expect(tokensOf(snapshot, "conversation")).toBe(
      estimateTokens("你好，帮我看看天气") + 4
      + estimateTokens("好的，我来查一下") + 4
      + estimateTokens(buildCompactionCheckpoint("早前对话的摘要").content as string) + 4,
    );
    expect(tokensOf(snapshot, "other")).toBe(0);
    expect(snapshot.messageCount).toBe(5);
  });

  it("优先级钉死：带 visibility:internal 的 compaction checkpoint 归入 conversation", () => {
    const checkpoint = buildCompactionCheckpoint("摘要内容");
    const ambiguous: ChatMessage = { ...checkpoint, visibility: "internal" };
    const snapshot = snapshotOf([ambiguous]);
    expect(tokensOf(snapshot, "conversation")).toBe(estimateTokens(checkpoint.content as string) + 4);
    expect(tokensOf(snapshot, "runtimeAndToolLogs")).toBe(0);
  });

  it("tool 消息优先于 internal 判定（role:tool 恒归运行时与工具日志）", () => {
    const snapshot = snapshotOf([
      { role: "tool", toolCallId: "call-1", name: "t", content: "x", visibility: "internal" },
    ]);
    expect(tokensOf(snapshot, "runtimeAndToolLogs")).toBe(estimateTokens("x") + 4);
    expect(tokensOf(snapshot, "conversation")).toBe(0);
  });

  it("toolSpecs 折算进 tools（与 computeTokenBudget 同公式）", () => {
    const spec = { name: "weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } } } };
    const snapshot = snapshotOf([], {
      toolLayerContent: "## 当前可用工具",
      toolSpecs: [spec],
    });
    const expectedSchema = estimateTokens(spec.name + spec.description + JSON.stringify(spec.parameters));
    expect(tokensOf(snapshot, "tools")).toBe(estimateTokens("## 当前可用工具") + expectedSchema);
  });

  it("skillLayerContent 把技能从工具层拆出单独计量", () => {
    const skillLayer = "## 可用技能\n- music: 音乐技能";
    const toolLayer = `## 当前可用工具\n\n---\n\n${skillLayer}\n\n---\n\n[当前项目工作区]\n可信根目录：/tmp`;
    const snapshot = snapshotOf([], {
      toolLayerContent: toolLayer,
      skillLayerContent: skillLayer,
    });
    expect(tokensOf(snapshot, "skills")).toBe(estimateTokens(skillLayer));
    expect(tokensOf(snapshot, "tools")).toBe(estimateTokens(toolLayer) - estimateTokens(skillLayer));
    // 拆分不改变总量：tools + skills == 工具层全量。
    expect(tokensOf(snapshot, "tools") + tokensOf(snapshot, "skills")).toBe(estimateTokens(toolLayer));
  });

  it("缺省 skillLayerContent 时不拆分，全部计入工具类", () => {
    const snapshot = snapshotOf([], { toolLayerContent: "## 当前可用工具" });
    expect(tokensOf(snapshot, "skills")).toBe(0);
    expect(tokensOf(snapshot, "tools")).toBe(estimateTokens("## 当前可用工具"));
  });

  it("runtimeContext 单独计量且含 wire 包装开销；messages 不含尾部注入时不双重计数", () => {
    const runtime = "环境：桌面\n记忆：用户喜欢简洁";
    const snapshot = snapshotOf([{ role: "user", content: "你好" }], { runtimeContext: runtime });
    expect(tokensOf(snapshot, "runtimeAndToolLogs")).toBe(
      estimateTokens(`<runtime_context>\n${runtime.trim()}\n</runtime_context>`),
    );
    // conversation 只有 user 消息，runtime_context 未重复计入
    expect(tokensOf(snapshot, "conversation")).toBe(estimateTokens("你好") + 4);
  });

  it("空消息与空文本时各类为 0，totalTokens 恒等于 Σ categories", () => {
    const snapshot = snapshotOf([]);
    expect(snapshot.messageCount).toBe(0);
    expect(tokensOf(snapshot, "systemPrompt")).toBe(estimateTokens("你是昔涟。"));
    const sum = snapshot.categories.reduce((acc, category) => acc + category.tokens, 0);
    expect(snapshot.totalTokens).toBe(sum);
  });

  it("phase/runId/round 透传", () => {
    const snapshot = buildContextUsageSnapshot({
      phase: "terminal",
      runId: "run-1",
      round: 3,
      contextWindowTokens: WINDOW,
      personaContent: "p",
      messages: [],
    });
    expect(snapshot.phase).toBe("terminal");
    expect(snapshot.runId).toBe("run-1");
    expect(snapshot.round).toBe(3);
  });
});
