// chatgpt（OpenAI）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const CHATGPT_REGISTRY = defineVendor({
  capability: {
    id: "chatgpt",
    displayName: "ChatGPT（OpenAI）",
    // 官方主推 Responses（o 系列完整思考摘要仅此协议有）——默认切换（施工文档关键决策）。
    // 旧档案已固化 explicitTransport，不受默认值影响；仅新建档案/无显式值时生效。
    transport: "responses",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "bearer",
    defaultModel: "",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 双协议：Chat Completions + Responses（Responses 为官方主推）
    supportedTransports: ["openai", "responses"],
    // 端点级标记：仅 OpenAI 官方端点支持 encrypted reasoning 回放
    responsesEncryptedReasoning: true,
  },
  // 状态栏短名，与 presets 的 shortName "GPT" 对齐（一致性测试校验两侧相等）
  presetDefaults: {
    baseUrl: "https://api.openai.com/v1",
    transport: "responses",
  },
  models: [
    {
      model: "gpt-6-astra",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-6.1-sol",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-6-sol",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-6-luna",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-5.6",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-5.6-terra",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gpt-5.6-luna",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "responses", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "responses", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
  ],
  shortName: "GPT",
  samplingRules: [
    {

      modelPattern: /^(?:gpt-4o(?:-mini)?|gpt-4\.1(?:-(?:mini|nano))?)$/i,
      diversity: true,
      repetition: "openai",
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "openai-structured-output",

      transport: "openai",
      // gpt-6 按家族前缀匹配（已发布型号自动覆盖：astra / sol / luna），
      // 不预测未来小版本号，协议兼容矩阵比 UI 能力表更保守。
      modelPattern: /^(?:gpt-6(?:$|-)|gpt-5(?:\.\d+)?(?:-(?:sol|terra|luna))?|gpt-4\.1(?:$|-)|gpt-4o-mini(?:$|-)|gpt-4o-(?:2024-08-06|2024-11-20)|o[134](?:$|-))/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── chatgpt（OpenAI）──
    // 按具体型号拆分。
    // GPT-6.1 Sol（2026-09-29 发布）：GPT-6 Sol 的升级款，定位在旗舰 Astra 之下，
    // 1.1M 上下文，agentic coding / 文档密集任务接近 Astra 水平而成本低得多。
    // effort 与 Sol 相同（可关闭 → supportsDisable=true），pro mode 同样支持。
    // 必须排在 /^gpt-6/（Astra 兜底，禁关思考）之前：/^gpt-6-/ 匹配不到 "gpt-6.1-"，
    // 不前置会被 Astra 规则误吞。
    { modelPattern: /^gpt-6\.1/i, modelInferencePattern: /^gpt-6\.1/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
      supportsProMode: true,
    } },
    // GPT-6 Sol / Luna（2026-09-22 发布）：Astra 能力下放的日常工作款。官方模型页
    // effort 支持 none/low/medium(默认)/high/xhigh/max —— 与 Astra 不同，可关闭
    // 思考（off → reasoning_effort:"none"）；pro mode 与 GPT-6 系一致支持。
    // 官方限制：Chat Completions 下函数调用仅 effort=none 可用，走 Responses
    // transport 不受限（capability 默认 transport 已是 responses）。
    { modelPattern: /^gpt-6-(?:sol|luna)/i, modelInferencePattern: /^gpt-6-(?:sol|luna)/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
      supportsProMode: true,
    } },
    // GPT-6 Astra（2026-09-03 发布）：effort 五档与 5.6 相同，
    // 官方迁移说明明确不支持 none 档 → supportsDisable=false，off 折叠为 on 落
    // defaultEffort；pro mode 与 5.6 一致继续支持（官方迁移指南）。
    // defaultEffort 是 Cyrene 的产品默认档（质量/延迟/成本的平衡点），非官方 API 默认。
    { modelPattern: /^gpt-6/i, modelInferencePattern: /^gpt-6/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
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
    { modelPattern: /^gpt-5\.6/i, modelInferencePattern: /^gpt-5\.6/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
      supportsProMode: true,
    } },
    { familyLabel: "gpt-5 系列", modelPattern: /^gpt-5/i, modelInferencePattern: /^gpt-5/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["minimal", "low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { familyLabel: "o1 系列", modelPattern: /^o1/i, modelInferencePattern: /^o1/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { familyLabel: "o3 系列", modelPattern: /^o3/i, modelInferencePattern: /^o3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
    { familyLabel: "o4 系列", modelPattern: /^o4/i, modelInferencePattern: /^o4/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/chatgpt.ts"), capability: {
      control: "effort",
      supportedEfforts: ["medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
  ],
});
