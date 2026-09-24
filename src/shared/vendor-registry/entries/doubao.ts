// doubao（火山方舟）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const DOUBAO_REGISTRY = defineVendor({
  id: "doubao",
  reasoningRules: [
    // ── doubao（火山方舟）──
    { providerId: "doubao", modelPattern: /^doubao-seed-/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "doubao", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
