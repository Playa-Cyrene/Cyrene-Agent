// grok（xAI）的注册表条目 —— 官方 API 原生 OpenAI 兼容（Chat Completions + Responses 双端点）。
// 思考档位与返回字段以官方 reasoning 文档（docs.x.ai，2026-09）为准。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const GROK_REGISTRY = defineVendor({
  capability: {
    id: "grok",
    displayName: "Grok（xAI）",
    transport: "openai",
    baseUrl: "https://api.x.ai/v1",
    authStyle: "bearer",
    defaultModel: "grok-4.7",
    supportsTools: true,
    supportsThinking: true,
    // Chat Completions 流式实测返回 reasoning_content（官方 reasoning 文档流式示例）
    thinkingField: "reasoning_content",
    // 官方自动 prompt caching：服务端命中即折扣，无需显式 cache key
    cacheStrategy: "auto",
    testStrategy: "text",
    // grok-4.x 系官方支持 jpg/png 图像输入（≤20MiB），read_image 门控放行
    supportsVision: true,
    // Chat Completions + Responses 双协议均有官方 quickstart 示例
    supportedTransports: ["openai", "responses"],
  },
  shortName: "Grok",
  reasoningRules: [
    // ── grok（xAI）──
    // 官方明确"思考不可关闭"（Reasoning cannot be disabled），
    // 全系 supportsDisable=false，off 折叠为 on 落 defaultEffort。
    // 4.20 multi-agent 变体的 effort 控制的是协作 agent 数量（4 或 16）而非思考深度，
    // 不能用 effort 滑块表达 → fixed-on：不发 reasoning_effort，走服务端默认。
    { providerId: "grok", modelPattern: /^grok-4\.20-multi-agent/i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    // grok-4.7 / 4.6：四档 effort（xhigh 为 4.6 起支持，4.5 发 xhigh 会被当 high）。
    // 服务端默认即 high，产品默认取 high 与服务端一致，无隐性成本差。
    { providerId: "grok", modelPattern: /^grok-4\.[67]/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    // grok-4.5：官方确认无 xhigh 档，仅三档。
    { providerId: "grok", modelPattern: /^grok-4\.5/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "high",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    // 其余 grok-4 系列（4.3 / 4.20 / 4.1-fast 等）：x.ai 官方 reasoning 文档未逐一列档，
    // Bedrock 发布文与第三方网关实测均为 low/medium/high 三档，保守覆盖。
    { providerId: "grok", modelPattern: /^grok-4/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "high",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    // grok-build-0.1 等编码款思考行为未核实，走通配兜底不出思考 UI
    { providerId: "grok", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
