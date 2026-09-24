// minimax（稀宇科技）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const MINIMAX_REGISTRY = defineVendor({
  capability: {
    id: "minimax",
    displayName: "MiniMax（稀宇科技）",
    // 官方对 M 系列优先推荐 Anthropic SDK；OpenAI 兼容入口仍可由用户显式选择。
    transport: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    // OpenAI 兼容入口使用 Bearer；Anthropic 入口由下方 override 使用 x-api-key。
    authStyle: "bearer",
    anthropicAuthStyle: "x-api-key",
    defaultModel: "MiniMax-M3",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // M3 原生多模态（image_url / video_url）
    supportsVision: true,
    // 视觉仍走 OpenAI 兼容入口。
    visionBaseUrl: "https://api.minimaxi.com/v1",
    // 三协议全支持（协议矩阵 2026-08-21）
    supportedTransports: ["anthropic", "openai", "responses"],
  },
  shortName: "MiniMax",
  // 厂商怪癖：OpenAI 兼容文本 API 的 tool_choice 文档仅支持 auto/none，
  // must-call 一律首选 auto。
  toolChoiceQuirk: {
    mustCall: { preferred: "auto", when: "always" },
  },
  reasoningRules: [
    // ── minimax（稀宇科技）──
    // M3 走 anthropic-adaptive（on=adaptive / off=disabled），不用通用 thinking-type 路径。
    { providerId: "minimax", modelPattern: /^MiniMax-M3/i, capability: {
      control: "toggle",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "minimax", modelPattern: /^MiniMax-M2\./i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { providerId: "minimax", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
