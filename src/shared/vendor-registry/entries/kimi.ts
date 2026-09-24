// kimi（月之暗面）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const KIMI_REGISTRY = defineVendor({
  id: "kimi",
  reasoningRules: [
    // ── kimi（月之暗面）──
    // K3：旗舰思考模型（2026-07 发布）。思考始终开启（Preserved Thinking 常开），
    // 不用 K2.x 的 thinking 参数，用顶层 reasoning_effort（low/high/max，默认 max）。
    // 强制思考 + 服务端默认 max → 与 GLM-5.3 同体质，auto 同样显式映射 high 防思考爆炸。
    { providerId: "kimi", modelPattern: /^kimi-k3/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "openai-effort",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // K2.7-Code / K2.7-Code-HighSpeed 必须用精确正则（$-anchor），
    // 且排在通用 kimi-k2-thinking 系列之前。
    { providerId: "kimi", modelPattern: /^kimi-k2\.7-code-highspeed$/i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { providerId: "kimi", modelPattern: /^kimi-k2\.7-code$/i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { providerId: "kimi", modelPattern: /^kimi-k2\.6/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
      keepOnTools: true,
    } },
    { providerId: "kimi", modelPattern: /^kimi-k2\.5/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
      keepOnTools: false,
    } },
    { providerId: "kimi", modelPattern: /^kimi-k2-thinking/i, capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { providerId: "kimi", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
