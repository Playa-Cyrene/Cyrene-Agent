// kimi（月之暗面）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const KIMI_REGISTRY = defineVendor({
  capability: {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    // OpenAI 兼容 + prompt_cache_key + function.name 正则限制；baseUrl 必须是 .cn
    transport: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    authStyle: "bearer",
    defaultModel: "kimi-k2.7-code",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "prompt_cache_key",
    testStrategy: "text",
    // k2.7-code 支持 image_url / video_url content block
    supportsVision: true,
    // 官方仅兼容 Chat Completions（协议矩阵 2026-08-21）
    supportedTransports: ["openai"],
  },
  // 厂商怪癖：fixed-thinking / 思考中的模型拒绝指定工具选择，
  // must-call 首选 auto 保持原生 Function Calling。
  toolChoiceQuirk: {
    mustCall: { preferred: "auto", when: "thinking-only" },
  },
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
