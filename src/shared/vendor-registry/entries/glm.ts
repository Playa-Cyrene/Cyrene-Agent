// glm（智谱）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const GLM_REGISTRY = defineVendor({
  id: "glm",
  reasoningRules: [
    // ── glm（智谱）──
    // 精确型号在前；glm-5 基础型号放在精确型号之后（兜底更宽的 glm-5 系列）。
    // GLM-5.3 / GLM-5.3-Flash：强制思考模型（thinking.type=disabled 服务端报错，
    // 官方文档 2026-08-26；z.ai 文档明确 FLASH 同为强制思考；
    // 2026-09-06 实测方舟托管端点 api/coding/v3 同样返回 400，强制思考跨端点成立）。
    // 支持 low/high/max 三档 effort（方舟端点 reasoning_effort 实测可用）。
    // auto 档显式映射 high —— 服务端默认 max，auto 不发字段 ≡ max，多步任务思考爆炸。
    { providerId: "glm", modelPattern: /^glm-5\.3/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // GLM-5.2：支持关闭思考；effort 档位较全。auto 同样映射 high（服务端默认偏重）。
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
