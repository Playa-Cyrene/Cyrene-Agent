// mimo（小米）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const MIMO_REGISTRY = defineVendor({
  capability: {
    id: "mimo",
    displayName: "MiMo（小米）",
    // 默认使用 OpenAI 入口；Anthropic 入口由用户在设置中明确选择。
    transport: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    // 官方文档：/v1 与 /anthropic 都支持 Authorization: Bearer
    authStyle: "bearer",
    defaultModel: "mimo-v2.5-pro",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    supportsVision: true,
    // 结构上独立：用户切主入口到 /anthropic 时视觉仍由 visionBaseUrl 决定
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
    // 三格式原生全支持（协议矩阵 2026-08-21）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  shortName: "MiMo",
  reasoningRules: [
    // ── mimo（小米）──
    // 跨 transport 共用：OpenAI 入口 + Anthropic 入口都生成 thinking.type。
    { providerId: "mimo", modelPattern: /^mimo-v2\./i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "mimo", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
