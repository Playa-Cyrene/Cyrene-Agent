// 预期来自本轮明确保留的历史兼容约束，不从注册表生成。
// 每组用实际型号验证首条命中；公共转换算法另由真实适配器请求用例保护。
import { describe, expect, test } from "vitest";
import { resolveReasoningCapability, type ReasoningCapability, type ReasoningEffort } from "../reasoning";
import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";

const toggle = (extras: Partial<ReasoningCapability> = {}): ReasoningCapability => ({
  control: "toggle", requestStyle: "thinking-type", supportsDisable: true, ...extras,
});
const fixed: ReasoningCapability = { control: "fixed-on", requestStyle: "none", supportsDisable: false };
const effort = (supportedEfforts: ReasoningEffort[], extras: Partial<ReasoningCapability> = {}): ReasoningCapability => ({
  control: "effort", requestStyle: "openai-effort", supportsDisable: true,
  supportedEfforts, defaultEffort: "medium", ...extras,
});
const five: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const chatgptEfforts: ReasoningEffort[] = [...five, "ultra"];
const three: ReasoningEffort[] = ["low", "medium", "high"];
const claude = (efforts: ReasoningEffort[] = five) => effort(efforts, {
  control: "toggle-effort", requestStyle: "anthropic-adaptive", defaultEffort: "high",
});

const CASES: readonly [string, readonly string[], ReasoningCapability][] = [
  ["chatgpt", ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-terra"], effort(chatgptEfforts, { supportsProMode: true })],
  ["chatgpt", ["gpt-6-astra"], effort(chatgptEfforts, { supportsDisable: false, supportsProMode: true })],
  ["chatgpt", ["gpt-5", "gpt-5-mini"], effort(["minimal", "low", "medium", "high"])],
  ["chatgpt", ["o1-preview", "o3-mini"], effort(three)],
  ["chatgpt", ["o4-mini"], effort(["medium", "high"])],
  ["claude", ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"], claude()],
  ["claude", ["claude-sonnet-4-6"], claude(["low", "medium", "high", "xhigh"])],
  ["deepseek", ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"], effort(["low", "high", "max"], {
    control: "toggle-effort", requestStyle: "thinking-type", defaultEffort: "high", autoEffort: "high",
  })],
  ["glm", ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"], effort(["low", "high", "max"], {
    control: "toggle-effort", requestStyle: "thinking-type", defaultEffort: "high", autoEffort: "high", supportsDisable: false,
  })],
  ["glm", ["glm-5.2"], effort(five, { control: "toggle-effort", requestStyle: "thinking-type", defaultEffort: "high", autoEffort: "high" })],
  ["glm", ["glm-5-turbo", "glm-5v-turbo", "glm-5.1", "glm-5", "glm-4.5", "glm-4.6", "glm-4.7"], toggle()],
  ["qwen", ["qwen3-thinking", "qwen-plus-thinking"], fixed],
  ["qwen", ["qwen3.8-max", "qwen-max", "qwen-plus", "qwen-turbo"], toggle({ requestStyle: "qwen-enable-thinking" })],
  ["kimi", ["kimi-k3"], effort(["low", "high", "max"], { supportsDisable: false, defaultEffort: "high", autoEffort: "high" })],
  ["kimi", ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2-thinking"], fixed],
  ["kimi", ["kimi-k2.6"], toggle({ keepOnTools: true })],
  ["kimi", ["kimi-k2.5"], toggle({ keepOnTools: false })],
  ["minimax", ["MiniMax-M3.1-Flash-Preview"], effort(five, {
    control: "toggle-effort", requestStyle: "anthropic-adaptive", supportsDisable: false, defaultEffort: "high", autoEffort: "high",
  })],
  ["minimax", ["MiniMax-M3"], toggle({ requestStyle: "anthropic-adaptive", defaultMode: "off" })],
  ["minimax", ["MiniMax-M2.7", "MiniMax-M2.5"], fixed],
  ["mimo", ["mimo-v2.5-pro", "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"], toggle()],
  ["doubao", ["doubao-seed-2-1-pro-260628"], toggle()],
  ["grok", ["grok-4.20-multi-agent"], fixed],
  ["grok", ["grok-4.7", "grok-4.6"], effort(["low", "medium", "high", "xhigh"], { supportsDisable: false, defaultEffort: "high" })],
  ["grok", ["grok-4.5", "grok-4.20"], effort(three, { supportsDisable: false, defaultEffort: "high" })],
  ["gemini", ["gemini-3.8-flash", "gemini-3.1-pro", "gemini-2.5-pro"], effort(three, { supportsDisable: false })],
  ["gemini", ["gemini-2.5-flash", "gemini-2.5-flash-lite"], effort(three, { control: "toggle-effort" })],
];

describe("历史型号的完整推理行为契约", () => {
  test.each(CASES.flatMap(([provider, models, expected]) => models.map((model) => [provider, model, expected] as const)))
    ("%s / %s 保留原控制、档位、默认值与工具约束", (provider, model, expected) => {
      expect(resolveReasoningCapability(provider, model)).toEqual(expected);
    });

  test.each([
    ["deepseek", "deepseek-chat"], ["deepseek", "deepseek-reasoner"],
    ["kimi", "kimi-k2.7-code-other"], ["grok", "grok-build-0.1"],
    ["other", "other-thinking"], ["gemini", "gemini-unlisted"],
  ])("%s / %s 保留未知单例，邻近后缀不自动扩充精确规则", (provider, model) => {
    expect(resolveReasoningCapability(provider, model)).toBe(UNKNOWN_REASONING_CAPABILITY);
  });
});
