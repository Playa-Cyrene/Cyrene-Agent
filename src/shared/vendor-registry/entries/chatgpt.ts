// chatgpt（OpenAI）的推理规则 —— 自 shared/reasoning.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const CHATGPT_REGISTRY = defineVendor({
  id: "chatgpt",
  reasoningRules: [
    // ── chatgpt（OpenAI）──
    // 按具体型号拆分；GPT-6 Astra（2026-09-03 发布）：effort 五档与 5.6 相同，
    // 官方迁移说明明确不支持 none 档 → supportsDisable=false，off 折叠为 on 落
    // defaultEffort；pro mode 与 5.6 一致继续支持（官方迁移指南）。
    // defaultEffort 是 Cyrene 的产品默认档（质量/延迟/成本的平衡点），非官方 API 默认。
    { providerId: "chatgpt", modelPattern: /^gpt-6/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: false,
      supportsProMode: true,
    } },
    // GPT-5.6 当前 Chat Completions 接受 low/medium/high/xhigh/max
    // （不含 minimal）；supportsDisable=true，off → reasoning_effort:"none"。
    // supportsProMode=true：Responses API 支持 reasoning.mode:"pro"（与 effort 正交）。
    { providerId: "chatgpt", modelPattern: /^gpt-5\.6/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
      supportsProMode: true,
    } },
    { providerId: "chatgpt", modelPattern: /^gpt-5/i, capability: {
      control: "effort",
      supportedEfforts: ["minimal", "low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { providerId: "chatgpt", modelPattern: /^o1/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { providerId: "chatgpt", modelPattern: /^o3/i, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { providerId: "chatgpt", modelPattern: /^o4/i, capability: {
      control: "effort",
      supportedEfforts: ["medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { providerId: "chatgpt", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
