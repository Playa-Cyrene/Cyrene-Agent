// claude（Anthropic）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const CLAUDE_REGISTRY = defineVendor({
  id: "claude",
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
