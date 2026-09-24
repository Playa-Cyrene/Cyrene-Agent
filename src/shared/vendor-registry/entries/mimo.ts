// mimo（小米）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const MIMO_REGISTRY = defineVendor({
  id: "mimo",
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
