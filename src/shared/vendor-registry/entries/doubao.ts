// doubao（火山方舟）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const DOUBAO_REGISTRY = defineVendor({
  capability: {
    id: "doubao",
    displayName: "豆包（火山方舟）",
    transport: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authStyle: "bearer",
    defaultModel: "doubao-seed-2-1-pro-260628",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "none",
    testStrategy: "text",
    supportsVision: true,
    // 火山方舟三格式全兼容（官方文档）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  shortName: "豆包",
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
