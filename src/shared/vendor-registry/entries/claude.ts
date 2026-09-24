// claude（Anthropic）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const CLAUDE_REGISTRY = defineVendor({
  capability: {
    id: "claude",
    displayName: "Claude（Anthropic）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    defaultModel: "claude-sonnet-4-6",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // Claude 支持多模态 image content block
    supportsVision: true,
    // 自家协议 only
    supportedTransports: ["anthropic"],
  },
  reasoningRules: [
    // ── claude（Anthropic）──
    { providerId: "claude", modelPattern: /^claude-fable-5/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-sonnet-5/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-opus-4-(8|7|6)/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-sonnet-4-6/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
