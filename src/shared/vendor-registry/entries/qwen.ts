// qwen（通义千问）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const QWEN_REGISTRY = defineVendor({
  capability: {
    id: "qwen",
    displayName: "Qwen（通义千问）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authStyle: "bearer",
    defaultModel: "qwen-max",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 视觉版是 qwen-vl 系列，默认 qwen-max 不支持
    supportsVision: false,
    // 官方 OpenAI 兼容；Responses 由阿里云百炼中转（协议矩阵 2026-08-21）
    supportedTransports: ["openai", "responses"],
  },
  reasoningRules: [
    // ── qwen（通义千问）──
    // /-thinking$/ 必须在 /^qwen3/ 之前。
    { providerId: "qwen", modelPattern: /-thinking$/i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    // qwen3 系列（含 3.5/3.6/3.7/3.8 全系，官方 2026-08-26 文档）：混合思考模式，
    // enable_thinking 开关控制，3.8 起默认开启思考。Chat Completions 无 effort 档位
    //（effort 仅 Responses API 支持；thinking_budget 实测不生效），保持纯 toggle。
    { providerId: "qwen", modelPattern: /^qwen3/i, capability: {
      control: "toggle",
      requestStyle: "qwen-enable-thinking",
      supportsDisable: true,
    } },
    { providerId: "qwen", modelPattern: /^qwen-(max|plus|turbo)/i, capability: {
      control: "toggle",
      requestStyle: "qwen-enable-thinking",
      supportsDisable: true,
    } },
    { providerId: "qwen", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
