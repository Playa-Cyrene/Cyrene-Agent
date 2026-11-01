// resolver 行为基准（golden）—— 直测 resolveReasoningCapability 的四类关键场景。
//
// 与 order-snapshot 的分工：snapshot 证明"数据没变"，本文件证明"行为没变"。
// 数据一致但行为退化（例如恒等判断被破坏）只有这里能抓住。
import { describe, expect, test } from "vitest";
import { resolveReasoningCapability } from "../reasoning";
import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";
import { renderAdaptedModelsMarkdown } from "./catalog-doc";
import { KIMI_REGISTRY } from "./entries/kimi";

describe("resolveReasoningCapability — 行为基准", () => {
  test.each(["other-thinking", "not-qwen3-thinking", "qwenish-thinking"])("外来型号 %s 不按后缀推断为通义千问", (model) => {
    expect(resolveReasoningCapability("unknown-provider", model)).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  test("真实千问家族仍可跨厂商推断；厂商内后缀规则优先", () => {
    expect(resolveReasoningCapability("unknown-provider", "qwen3-thinking").control).toBe("fixed-on");
    expect(resolveReasoningCapability("unknown-provider", "qwen-plus-thinking").control).toBe("fixed-on");
    expect(resolveReasoningCapability("qwen", "custom-thinking").control).toBe("fixed-on");
  });

  test("同厂商精确命中：glm + glm-5.3 → 强制思考 + autoEffort=high", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
  });

  test("厂商内排序敏感：qwen + qwen3-thinking → /-thinking$/ 先于 /^qwen3/ 命中 fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-thinking");
    expect(cap.control).toBe("fixed-on");
    expect(cap.requestStyle).toBe("none");
  });

  test("托管端点跨家族二轮：doubao + glm-5.3（方舟上跑 GLM）→ 找回 glm 家族规则", () => {
    const cap = resolveReasoningCapability("doubao", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.autoEffort).toBe("high");
  });

  test("跨家族二轮另一向：glm + gpt-6 → 找回 chatgpt 家族规则", () => {
    const cap = resolveReasoningCapability("glm", "gpt-6");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
  });

  test("未知模型落兜底：glm + 完全不匹配的模型名 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("glm", "totally-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(cap.control).toBe("none");
  });

  test("未知厂商 + 未知模型 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("some-unknown-vendor", "some-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  test("兜底单例全局唯一：所有厂商表尾 /.*/ 引用同一实例", () => {
    for (const vendorId of ["chatgpt", "claude", "deepseek", "glm", "qwen", "kimi", "minimax", "mimo", "doubao"]) {
      const cap = resolveReasoningCapability(vendorId, "zzz-no-such-model");
      expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    }
  });

  // 预期值按官方文档独立填写（effort 文档，核验 2026-10-08），不从注册表复制。
  // 预期值按官方模型总览与 effort 文档独立填写（核验 2026-11-01），不从注册表复制。
  test.each([
    ["claude-fable-5-1", "high", false],
    ["claude-opus-5-5", "medium", false],
    ["claude-opus-5", "high", true],
    ["claude-sonnet-5-5", "high", false],
  ] as const)("claude + %s → 自适应思考，五档 effort，默认 %s，可关闭=%s", (model, defaultEffort, supportsDisable) => {
    const cap = resolveReasoningCapability("claude", model);
    expect(cap.requestStyle).toBe("anthropic-adaptive");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cap.defaultEffort).toBe(defaultEffort);
    expect(cap.supportsDisable).toBe(supportsDisable);
  });

  test("新一代 Claude 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "claude-opus-5-5").defaultEffort).toBe("medium");
    expect(resolveReasoningCapability("unknown-provider", "claude-sonnet-5-5").supportsDisable).toBe(false);
  });

  test("邻近反例：未发布的 claude-sonnet-5-6 / claude-opus-5-1 不套用新规则，落兜底", () => {
    expect(resolveReasoningCapability("claude", "claude-sonnet-5-6")).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(resolveReasoningCapability("claude", "claude-opus-5-1")).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  test("claude + claude-haiku-5-5 → 自适应思考，五档 effort，默认 medium，可关闭", () => {
    const cap = resolveReasoningCapability("claude", "claude-haiku-5-5");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cap.defaultEffort).toBe("medium");
    expect(cap.supportsDisable).toBe(true);
  });

  test("Haiku 5.5 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "claude-haiku-5-5").defaultEffort).toBe("medium");
  });

  // 预期值按官方文档独立填写（思考文档、OpenAI 兼容文档与模型页，核验 2026-10-18），不从注册表复制。
  test("gemini + gemini-4-argon → reasoning_effort 三档 low/medium/high，默认 medium，不可关闭", () => {
    const cap = resolveReasoningCapability("gemini", "gemini-4-argon");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high"]);
    expect(cap.defaultEffort).toBe("medium");
    expect(cap.supportsDisable).toBe(false);
  });

  test("Gemini 4 Argon 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "gemini-4-argon").defaultEffort).toBe("medium");
  });

  test("邻近反例：gemini-3.8-flash 仍走 gemini-3 规则，未核实的 gemini-4-flash 落兜底", () => {
    expect(resolveReasoningCapability("gemini", "gemini-3.8-flash").supportedEfforts).toEqual(["low", "medium", "high"]);
    expect(resolveReasoningCapability("gemini", "gemini-4-flash")).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  // 预期值按官方文档独立填写（K3.1 Pro 快速上手文档，核验 2026-10-24），不从注册表复制。
  // 官方默认 max；产品默认与 K3 一致压到 high，防止思考过长。
  test.each(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])("kimi + %s → reasoning_effort 三档 low/high/max，不可关闭，默认 high", (model) => {
    const cap = resolveReasoningCapability("kimi", model);
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.defaultEffort).toBe("high");
    expect(cap.supportsDisable).toBe(false);
  });

  test("K3.1 Pro 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "kimi-k3.1-pro").supportedEfforts).toEqual(["low", "high", "max"]);
  });

  test("邻近反例：官方依据只记在 K3.1 Pro 的完整型号名上，kimi-k3 仍是历史未核验", () => {
    const rows = renderAdaptedModelsMarkdown([KIMI_REGISTRY]).split("\n");
    const row = (model: string) => rows.find((line) => line.startsWith(`| ${model} |`)) ?? "";
    for (const model of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
      expect(row(model)).toContain("platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart.md");
      expect(row(model)).not.toContain("历史未核验");
    }
    expect(row("kimi-k3")).toContain("历史未核验");
  });

  // 预期值按官方文档独立填写（GPT-6.1 Terra / Sol 模型页与最新模型指南，核验 2026-10-28），不从注册表复制。
  test("chatgpt + gpt-6.1-terra → 五档 effort，默认 medium，可关闭（none），未写明 pro mode", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6.1-terra");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cap.defaultEffort).toBe("medium");
    expect(cap.supportsDisable).toBe(true);
    expect(cap.supportsProMode).toBeFalsy();
  });

  test("chatgpt + gpt-6.1-sol → 官方不支持 none，不可关闭", () => {
    expect(resolveReasoningCapability("chatgpt", "gpt-6.1-sol").supportsDisable).toBe(false);
  });

  test("GPT-6.1 Terra 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "gpt-6.1-terra").supportsDisable).toBe(true);
  });

  test("邻近反例：gpt-5.6-terra 仍走 GPT-5.6 规则，未核验的 gpt-6.1-* 名称不可关闭", () => {
    expect(resolveReasoningCapability("chatgpt", "gpt-5.6-terra").supportsProMode).toBe(true);
    expect(resolveReasoningCapability("chatgpt", "gpt-6.1-terra-preview").supportsDisable).toBe(false);
  });

  test("邻近反例：claude-haiku-4-5 不命中 Haiku 5.5 规则，仍落兜底", () => {
    // Haiku 4.5 只支持 budget_tokens 式思考，套用自适应规则会发出它不接受的请求
    expect(resolveReasoningCapability("claude", "claude-haiku-4-5")).toBe(UNKNOWN_REASONING_CAPABILITY);
  });
});
