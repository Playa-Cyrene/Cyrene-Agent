// deepseek（深度求索）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const DEEPSEEK_REGISTRY = defineVendor({
  capability: {
    id: "deepseek",
    displayName: "DeepSeek（深度求索）",
    transport: "openai",
    baseUrl: "https://api.deepseek.com",
    authStyle: "bearer",
    anthropicAuthStyle: "x-api-key",
    defaultModel: "deepseek-flash",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // V4.1 Flash（2026-09-10）原生多模态视觉理解；v4-pro 不支持视觉但官方已宣布
    // 2026-09-14 起全部路由到 V4.1 Flash
    supportsVision: true,
    // 三格式原生全支持（官方文档）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  reasoningRules: [
    // ── deepseek ──
    // V4.1 Flash（2026-09-10 发布，模型名 deepseek-flash，原生多模态）与 V4 旧名
    // （v4-pro / v4-flash / v4-flash-vision-exp，官方均已路由到 V4.1 Flash）统一规则：
    // thinking 默认开启可关闭；effort 官方仅 high/max 两档，low/medium 会被服务端
    // 映射为 high、xhigh 映射为 max（官方思考模式文档），故不再提供 low 档。
    // auto 映射 high：服务端 auto 会给带工具的 agent 请求自动上 max，
    // 与 GLM-5.3 同款的思考爆炸陷阱（2026-08-27 多轮循环场景）。
    { providerId: "deepseek", modelPattern: /^deepseek-(?:v4|flash)/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
      autoEffort: "high",
    } },
    { providerId: "deepseek", modelPattern: /^deepseek-(chat|reasoner)$/i, capability: UNKNOWN_REASONING_CAPABILITY },
    { providerId: "deepseek", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
