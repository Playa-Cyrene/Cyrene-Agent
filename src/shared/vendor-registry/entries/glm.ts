// glm（智谱）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const GLM_REGISTRY = defineVendor({
  capability: {
    id: "glm",
    displayName: "GLM（智谱）",
    transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authStyle: "bearer",
    defaultModel: "glm-5.2",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 视觉版是 glm-5v-turbo，默认 glm-5.2 不支持
    supportsVision: false,
    // OpenAI 兼容 + Anthropic 兼容（协议矩阵 2026-08-21，用户确认）
    supportedTransports: ["openai", "anthropic"],
  },
  shortName: "GLM",
  reasoningRules: [
    // ── glm（智谱）──
    // 精确型号在前；glm-5 基础型号放在精确型号之后（兜底更宽的 glm-5 系列）。
    // GLM-5.3 / GLM-5.3-Flash：强制思考模型（thinking.type=disabled 服务端报错，
    // 官方文档 2026-08-26；z.ai 文档明确 FLASH 同为强制思考；
    // 2026-09-06 实测方舟托管端点 api/coding/v3 同样返回 400，强制思考跨端点成立）。
    // 支持 low/high/max 三档 effort（方舟端点 reasoning_effort 实测可用）。
    // 默认选择 high 并显式发送 —— 服务端默认 max，多步任务思考开销过大。
    { providerId: "glm", modelPattern: /^glm-5\.3/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // GLM-5.2：支持关闭思考；effort 档位较全。默认选择 high（服务端默认偏重）。
    { providerId: "glm", modelPattern: /^glm-5\.2/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
      autoEffort: "high",
    } },
    { providerId: "glm", modelPattern: /^glm-5-turbo$/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "glm", modelPattern: /^glm-5v-turbo$/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "glm", modelPattern: /^glm-5\.1/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "glm", modelPattern: /^glm-5/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "glm", modelPattern: /^glm-(4\.5|4\.6|4\.7)/i, capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { providerId: "glm", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
