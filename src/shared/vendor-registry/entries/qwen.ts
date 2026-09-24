// qwen（通义千问）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const QWEN_REGISTRY = defineVendor({
  id: "qwen",
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
