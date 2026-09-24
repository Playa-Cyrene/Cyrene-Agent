// API 预设数据（厂商列表）
// 从 settings.ts 抽离的纯数据常量。
// 注意：引用了 CUSTOM_ENDPOINT_PROVIDERS（运行时值），需用 import（非 type-only）。

import type { ModelPreset } from "../shared/types";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../custom-endpoint-state";

export const MODEL_PRESETS: ModelPreset[] = [
  // 当前已适配 9 家：MiniMax / DeepSeek / 豆包 / 智谱 GLM / Kimi / Qwen / ChatGPT / Claude / MiMo
  // 顺序按使用频率 + 适配优先级；未在此清单内的厂商已硬删，需要时再补回。
  {
    providerName: "MiniMax（稀宇科技）",
    providerId: "minimax",
    shortName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    transport: "anthropic",
    mainModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
    iconUrl: "../icons/providers/minimax.svg",
    websiteUrl: "https://platform.minimaxi.com/",
    // 主模型默认走 Anthropic SDK；视觉继续走 OpenAI 兼容入口。
    visionBaseUrl: "https://api.minimaxi.com/v1",
  },
  {
    // DeepSeek：v1 vendor adapter 不为它做协议层强制，仅作为 OpenAI 兼容厂商列出。
    // 已确认（来自官方定价文档）：支持 Tool Calls / JSON Output；后端原生缓存（命中后输入价跌至 1/50~1/120）。
    // 缓存能力等 v2 vendor adapter 接入时再利用，v1 不动。
    // V4.1 Flash（2026-09-10 发布）：模型名 deepseek-flash，原生多模态视觉；
    // 旧名 v4-flash / v4-flash-vision-exp 是它的别名；v4-pro 官方将于 2026-09-14
    // 起路由到 V4.1 Flash，保留在列表里供存量配置参考。
    providerName: "DeepSeek（深度求索）",
    providerId: "deepseek",
    shortName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    transport: "openai",
    mainModels: ["deepseek-flash", "deepseek-v4-pro"],
    iconUrl: "../icons/providers/deepseek.svg",
    websiteUrl: "https://platform.deepseek.com/",
  },
  {
    providerName: "豆包（火山方舟）",
    providerId: "doubao",
    shortName: "豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    transport: "openai",
    mainModels: [
      "doubao-seed-2-1-pro-260628",
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-lite-260428",
      "doubao-seed-2-0-mini-260428",
    ],
    iconUrl: "../icons/providers/volcengine.svg",
    websiteUrl: "https://www.volcengine.com/product/ark",
  },
  {
    providerName: "GLM（智谱）",
    providerId: "glm",
    shortName: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    transport: "openai",
    mainModels: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7"],
    iconUrl: "../icons/providers/glm.svg",
    websiteUrl: "https://open.bigmodel.cn/",
  },
  {
    providerName: "Kimi（月之暗面）",
    providerId: "kimi",
    shortName: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    transport: "openai",
    mainModels: ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"],
    iconUrl: "../icons/providers/kimi.svg",
    websiteUrl: "https://platform.moonshot.cn/",
  },
  {
    providerName: "Qwen（通义千问）",
    providerId: "qwen",
    shortName: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    transport: "openai",
    mainModels: ["qwen-max", "qwen-plus", "qwen-turbo"],
    iconUrl: "../icons/providers/qwen.svg",
    websiteUrl: "https://bailian.console.aliyun.com/",
  },
  {
    providerName: "ChatGPT（OpenAI）",
    providerId: "chatgpt",
    shortName: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    // 官方主推 Responses（o 系列完整思考摘要仅此协议有），新建档案默认预填 responses。
    transport: "responses",
    // 官方入口只推荐已纳入结构化输出 Profile 的型号；代理与自定义型号走“自定义端点”。
    // gpt-6-astra 为 2026-09-03 新旗舰（API 正在分批开放中）；gpt-5.6 为别名，
    // 路由到旗舰 Sol；terra/luna 为平衡与低成本档。
    mainModels: ["gpt-6-astra", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
    iconUrl: "../icons/providers/openai.svg",
    websiteUrl: "https://platform.openai.com/",
  },
  {
    providerName: "Claude（Anthropic）",
    providerId: "claude",
    shortName: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    transport: "anthropic",
    mainModels: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    iconUrl: "../icons/providers/claude.svg",
    websiteUrl: "https://console.anthropic.com/",
  },
  {
    providerName: "MiMo（小米）",
    providerId: "mimo",
    shortName: "MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic",
    transport: "openai",
    mainModels: ["mimo-v2.5-pro"],
    iconUrl: "../icons/providers/xiaomimimo.svg",
    websiteUrl: "https://mimo.mi.com/",
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
    // 主模型 mimo-v2.5-pro 不适合做视觉（视觉模型是 mimo-v2.5）；
    // 多模态开关默认全开，仅在此预填独立视觉模型候选，用户自行决定。
    defaultVisionModel: "mimo-v2.5",
    visionModels: ["mimo-v2.5"],
  },
  {
    providerName: CUSTOM_ENDPOINT_PROVIDERS.cloud,
    providerId: "custom-cloud",
    shortName: "自定义",
    baseUrl: "",
    transport: "openai",
    mainModels: [],
    iconUrl: "../icons/providers/custom-endpoint.svg",
    customEndpointMode: "cloud",
  },
  {
    providerName: CUSTOM_ENDPOINT_PROVIDERS.local,
    providerId: "custom-local",
    shortName: "本地模型",
    baseUrl: "",
    transport: "openai",
    mainModels: [],
    iconUrl: "../icons/providers/custom-endpoint.svg",
    customEndpointMode: "local",
    hiddenInPresetList: true,
  },
];
