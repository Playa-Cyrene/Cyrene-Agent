// minimax（稀宇科技）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const MINIMAX_REGISTRY = defineVendor({
  id: "minimax",
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
