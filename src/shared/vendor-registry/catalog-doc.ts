import type { AdaptationEvidence, ModelSamplingRuleInput, RuleMetadata, StructuredOutputRuleInput } from "./model-types";
import type { ModelReasoningRule, Transport, VendorRegistryEntry } from "./types";
import { evidenceCoversEndpoint, evidenceCoversTransport } from "./validation";
import { getPresetTransportUrl } from "./preset-defaults";

const TRANSPORTS: readonly Transport[] = ["openai", "anthropic", "responses"];
type CatalogLocale = "zh" | "en";

const REASONING_LABELS = {
  zh: {
    none: "不提供思考控制", dynamic: "未知（需手动配置）", "fixed-on": "强制思考",
    toggle: "思考开关", effort: "思考档位", "toggle-effort": "思考开关与档位",
  },
  en: {
    none: "No reasoning control", dynamic: "Unknown (manual configuration required)", "fixed-on": "Reasoning always on",
    toggle: "Reasoning toggle", effort: "Reasoning effort", "toggle-effort": "Reasoning toggle and effort",
  },
} as const;
const OUTPUT_LABELS = {
  zh: { provider_json_schema: "JSON Schema", provider_json_object: "JSON 对象", prompt_json: "提示词 JSON（专用契约）" },
  en: { provider_json_schema: "JSON Schema", provider_json_object: "JSON object", prompt_json: "Prompt-based JSON (dedicated contract)" },
} as const;

const VENDOR_NAMES_EN: Readonly<Record<string, string>> = {
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  doubao: "Doubao (ByteDance)",
  glm: "GLM (Zhipu AI)",
  kimi: "Kimi (Moonshot AI)",
  qwen: "Qwen (Alibaba Cloud)",
  chatgpt: "OpenAI",
  claude: "Claude (Anthropic)",
  mimo: "MiMo (Xiaomi)",
  grok: "Grok (xAI)",
  gemini: "Gemini (Google)",
};

const TRANSPORT_NAMES_EN: Readonly<Record<Transport, string>> = {
  openai: "OpenAI Chat Completions",
  anthropic: "Anthropic Messages",
  responses: "OpenAI Responses",
};

// The registry is the source of truth for runtime declarations. Keep these
// translations here so both generated catalogs describe the same declarations.
const NOTES_EN: Readonly<Record<string, string>> = {
  "历史清单保留名称；不改写用户请求。": "Legacy catalog entry; the model name is sent as provided.",
  "现有采样白名单未覆盖该型号。": "The existing sampling allowlist does not cover this model.",
  "2026-10-07 发布；固定型号名，无日期后缀、无别名。": "Released 2026-10-07; a fixed model name with no date suffix and no alias.",
  "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。": "Officially, non-default temperature/top_p/top_k return a 400; with no sampling allowlist, no sampling parameters are sent.",
  "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。": "No dedicated structured output rule exists for the preset transport; prompt-based JSON fallback is retained.",
  "现有推理规则未确认该型号。": "The existing reasoning rule has not been verified for this model.",
  "MiniMax-M2.x 系列": "MiniMax M2.x family",
  "doubao-seed 系列": "Doubao Seed family",
  "glm-4.5 / glm-4.6 / glm-4.7": "GLM 4.5 / 4.6 / 4.7 families",
  "qwen-*-thinking 系列（厂商内后缀；跨厂商限明确千问前缀）": "Qwen *-thinking suffixes (provider-specific; cross-provider inference requires an explicit Qwen prefix)",
  "qwen3 系列（3.5 / 3.6 / 3.7 / 3.8）": "Qwen3 family (3.5 / 3.6 / 3.7 / 3.8)",
  "gpt-5 系列": "GPT-5 family",
  "o1 系列": "o1 family",
  "o3 系列": "o3 family",
  "o4 系列": "o4 family",
  "mimo-v2.x 系列（含 V2.5）": "MiMo V2.x family (including V2.5)",
  "grok-4 系列": "Grok 4 family",
  "gemini-3 系列": "Gemini 3 family",
};

function cell(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/`/g, "&#96;");
}

function localizedText(value: string, locale: CatalogLocale): string {
  if (locale === "zh") return value;
  const legacySource = value.match(/^迁自 (.+)$/);
  if (legacySource) return `Carried forward from ${legacySource[1]}; not verified against current documentation.`;
  return NOTES_EN[value] ?? value;
}

function transportName(transport: Transport, locale: CatalogLocale): string {
  if (locale === "en") return TRANSPORT_NAMES_EN[transport];
  return transport;
}

function evidenceLabel(evidence: AdaptationEvidence, locale: CatalogLocale): string {
  if (evidence.kind === "legacy") {
    return locale === "en"
      ? `Legacy, unverified: ${cell(localizedText(evidence.note, locale))}`
      : `历史未核验：${cell(evidence.note)}`;
  }
  if (evidence.kind === "official") {
    return locale === "en"
      ? `Official documentation [link](<${encodeURI(evidence.url).replace(/>/g, "%3E")}>) · checked ${cell(evidence.checkedAt)} · transports ${evidence.transports.map((item) => transportName(item, locale)).join(" / ")}`
      : `官方资料 [链接](<${encodeURI(evidence.url).replace(/>/g, "%3E")}>)；核验 ${cell(evidence.checkedAt)}；协议 ${evidence.transports.join(" / ")}`;
  }
  return locale === "en"
    ? `Redacted observation: ${cell(evidence.artifact)} · checked ${cell(evidence.checkedAt)} · transport ${transportName(evidence.transport, locale)} · endpoint ${cell(evidence.endpoint)}`
    : `脱敏实测：${cell(evidence.artifact)}；核验 ${cell(evidence.checkedAt)}；协议 ${evidence.transport}；端点 ${cell(evidence.endpoint)}`;
}

function declared(label: string, metadata: RuleMetadata | undefined, transport: Transport | undefined, endpoint: string | undefined, locale: CatalogLocale): string {
  const en = locale === "en";
  if (!metadata || metadata.status === "unknown") return en ? "Unknown (existing rule is unverified)" : "未知（已有规则未确认）";
  if (transport && !evidenceCoversTransport(metadata.evidence, transport)) return en ? "Unknown (evidence does not cover this transport)" : "未知（已有规则，证据未覆盖该协议）";
  if (endpoint && !evidenceCoversEndpoint(metadata.evidence, endpoint)) return en ? "Unknown (evidence does not cover this endpoint)" : "未知（已有规则，证据未覆盖该端点）";
  if (metadata.status === "unsupported") return en ? "Declared unsupported" : "声明不支持";
  return `${label}${metadata.evidence.kind === "legacy" ? (en ? " (legacy, unverified)" : "（历史未核验）") : ""}`;
}

function reasoningLabel(rule: ModelReasoningRule | undefined, transport: Transport | undefined, endpoint: string | undefined, locale: CatalogLocale): string {
  const en = locale === "en";
  if (!rule?.metadata) return en ? "Unknown (no dedicated rule)" : "未知（无专用规则）";
  const cap = rule.capability;
  const details = [
    cap.supportedEfforts?.length ? `${en ? "Supported efforts" : "档位"} ${cap.supportedEfforts.join(" / ")}` : "",
    cap.supportsDisable ? (en ? "can be disabled" : "可关闭") : (en ? "cannot be disabled" : "不可关闭"),
    cap.defaultEffort ? `${en ? "default" : "默认"} ${cap.defaultEffort}` : "",
    cap.autoEffort ? `${en ? "automatic" : "自动"} ${cap.autoEffort}` : "",
  ].filter(Boolean).join(en ? "; " : "；");
  return declared(`${REASONING_LABELS[locale][cap.control]}; ${details}`.replace(/; /g, en ? "; " : "；"), rule.metadata, transport, endpoint, locale);
}

function samplingLabel(rule: ModelSamplingRuleInput | undefined, transport: Transport | undefined, endpoint: string | undefined, locale: CatalogLocale): string {
  const en = locale === "en";
  if (!rule) return en ? "Unknown (no sampling allowlist)" : "未知（无采样白名单）";
  const details = [rule.diversity ? (en ? "temperature / top-p" : "温度 / Top-P") : (en ? "no diversity parameters" : "无多样性参数"),
    rule.repetition ? `${en ? "repetition penalty" : "重复惩罚"} ${rule.repetition}` : "",
    rule.requiresReasoningOff ? (en ? "only when reasoning is off" : "仅关闭思考时") : "",
    rule.maximumTemperature !== undefined ? `${en ? "maximum temperature" : "温度上限"} ${rule.maximumTemperature}` : "",
  ].filter(Boolean).join(en ? "; " : "；");
  return declared(details, rule.metadata, transport, endpoint, locale);
}

function outputLabel(rule: StructuredOutputRuleInput | undefined, endpoint: string | undefined, locale: CatalogLocale): string {
  const en = locale === "en";
  if (!rule) return en ? "Unknown (prompt-based JSON fallback)" : "未知（提示词 JSON 回退）";
  const hints = [rule.requestHints?.sendJsonObject ? (en ? "send JSON object hint" : "发送 JSON 对象提示") : "", rule.requestHints?.reasoningSplit ? (en ? "split reasoning" : "分离思考") : "",
    rule.repairOverrides?.length ? (en ? "uses an existing extended repair budget for some models" : "部分型号使用既有慢修复预算") : ""].filter(Boolean);
  const label = `${OUTPUT_LABELS[locale][rule.mode]}; ${en ? "tier" : "等级"} ${rule.tier}${hints.length ? `${en ? "; " : "；"}${hints.join(en ? "; " : "；")}` : ""}`;
  return declared(label.replace(/; /g, en ? "; " : "；"), rule.metadata, rule.transport, endpoint, locale);
}

function featureName(feature: string, locale: CatalogLocale): string {
  if (locale === "zh") return feature;
  return ({ reasoning: "reasoning", sampling: "sampling", structuredOutput: "structured output" } as Record<string, string>)[feature] ?? feature;
}

/** Pure projection of shared declarations; does not load main-process policy, UI, or paid APIs. */
export function renderAdaptedModelsMarkdown(entries: readonly VendorRegistryEntry[], locale: CatalogLocale = "zh"): string {
  const en = locale === "en";
  const separator = en ? ": " : "：";
  const lines = en ? [
    "# Model Compatibility Catalog", "", "<!-- Generated by pnpm run generate:adapted-models; do not edit manually. -->", "",
    "This catalog describes static declarations in the repository. It does not mean every model has been tested against the current official API. Migrated legacy rules are marked as unverified.", "",
    "- Model names, capability rules, and preset defaults are maintained in `src/shared/vendor-registry/entries/`.",
    "- Reasoning and sampling columns use the preset transport. Structured output is listed per transport and applies only to the existing official-endpoint checks. Relays, custom endpoints, and local endpoints retain the prompt-based JSON fallback.",
    "- Metadata records evidence; it does not change request behavior. Model names and aliases do not rewrite user requests. Sampling parameters are omitted when no allowlist applies.",
    "- Verification tiers retained from legacy code do not replace evidence checks in this catalog. Structured output falls back conservatively when no rule matches.",
    "- See the [model adaptation contribution guide](../contributing/model-adaptation.en.md) for contribution steps.", "",
  ] : [
    "# 模型适配清单", "", "<!-- 自动生成：pnpm run generate:adapted-models；不要手工修改此文件。 -->", "",
    "本清单描述仓库中的静态声明，不代表每个型号都经过当前官方接口实测。历史迁移规则统一标为「历史未核验」。", "",
    "- 型号目录、能力规则和界面预填值均维护在 `src/shared/vendor-registry/entries/`。",
    "- 推理与采样列按预设协议展示；结构化输出分协议列出，仅适用于现有官方端点判定。中转、自定义和本地端点保留提示词 JSON 回退。",
    "- 元数据记录证据，不改变请求策略。型号名称和别名说明不会自动重写用户请求。缺少白名单时采样参数不注入。",
    "- 历史代码中的验证等级保留原值，不能替代本清单的证据核验。未匹配结构化输出规则时保守回退。",
    "- 贡献步骤见 [模型适配贡献指南](../contributing/model-adaptation.md)。", "",
  ];

  for (const entry of entries) {
    const cap = entry.capability;
    const transport = entry.presetDefaults?.transport ?? cap.transport;
    const presetEndpoint = entry.presetDefaults ? getPresetTransportUrl(entry.presetDefaults, transport) : cap.baseUrl;
    const displayName = en ? (VENDOR_NAMES_EN[cap.id] ?? cap.displayName) : cap.displayName;
    lines.push(`## ${cell(displayName)}`, "",
      en ? `Preset transport: ${transportName(transport, locale)}; prefilled endpoint: ${cell(presetEndpoint)}.` : `预设协议：${transport}；预填地址：${cell(presetEndpoint)}。`, "",
      en ? `Runtime defaults: ${transportName(cap.transport, locale)} / ${cell(cap.baseUrl)} / ${cell(cap.defaultModel)}.` : `运行默认：${cap.transport} / ${cell(cap.baseUrl)} / ${cell(cap.defaultModel)}。`, "",
      en ? `Tools: provider-level declaration ${cap.supportsTools ? "supported" : "unsupported"}; not verified per model. Vision recommendations indicate intended catalog use and are not verified per model.` : `工具支持：厂商级声明 ${cap.supportsTools ? "支持" : "不支持"}，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。`, "",
      en ? "| Model | Recommended use | Reasoning (preset transport) | Sampling (preset transport) | Structured output (official endpoint) | Evidence and limits |" : "| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const item of entry.models ?? []) {
      const reasoning = entry.reasoningRules.find((rule) => rule.modelPattern.test(item.model));
      const sampling = entry.samplingRules?.find((rule) => rule.modelPattern.test(item.model));
      const outputs = TRANSPORTS.map((protocol) => ({ protocol,
        rule: entry.structuredOutputRules?.find((rule) => rule.transport === protocol && rule.modelPattern.test(item.model)),
      }));
      const evidence = [
        reasoning?.metadata ? `${en ? "Reasoning" : "推理"}${separator}${evidenceLabel(reasoning.metadata.evidence, locale)}` : "",
        sampling ? `${en ? "Sampling" : "采样"}${separator}${evidenceLabel(sampling.metadata.evidence, locale)}` : "",
        ...outputs.filter(({ rule }) => rule).map(({ protocol, rule }) => `${en ? "Output" : "输出"} ${transportName(protocol, locale)}${separator}${evidenceLabel(rule!.metadata.evidence, locale)}`),
        item.aliases?.length ? `${en ? "Aliases" : "别名说明"}: ${cell(item.aliases.join(" / "))}` : "",
        item.note ? cell(localizedText(item.note, locale)) : "",
        ...(item.unknownCapabilities ?? []).map((unknown) => `${en ? "Unknown" : "未知"} ${featureName(unknown.feature, locale)} / ${transportName(unknown.transport, locale)}${separator}${cell(localizedText(unknown.note, locale))}`),
      ].filter(Boolean).join("<br>") || (en ? "No model-specific evidence" : "无型号级证据");
      const recommendation = item.recommendedFor.map((purpose) => purpose === "chat" ? (en ? "Primary model" : "主模型") : (en ? "Vision" : "视觉")).join(" / ") || (en ? "Not recommended" : "非推荐");
      lines.push(`| ${cell(item.model)} | ${recommendation} | ${reasoningLabel(reasoning, transport, presetEndpoint, locale)} | ${samplingLabel(sampling, transport, presetEndpoint, locale)} | ${outputs.map(({ protocol, rule }) => `${transportName(protocol, locale)}${separator}${outputLabel(rule, cap.baseUrl, locale)}`).join("<br>")} | ${evidence} |`);
    }
    const families = [
      ...entry.reasoningRules.filter((rule) => rule.familyLabel).map((rule) => [en ? "Reasoning" : "推理", localizedText(rule.familyLabel!, locale), rule.modelPattern, reasoningLabel(rule, undefined, undefined, locale), rule.metadata!] as const),
      ...(entry.samplingRules ?? []).filter((rule) => rule.familyLabel).map((rule) => [en ? "Sampling" : "采样", localizedText(rule.familyLabel!, locale), rule.modelPattern, samplingLabel(rule, undefined, undefined, locale), rule.metadata] as const),
      ...(entry.structuredOutputRules ?? []).filter((rule) => rule.familyLabel).map((rule) => [`${en ? "Output" : "输出"} ${transportName(rule.transport, locale)}`, localizedText(rule.familyLabel!, locale), rule.modelPattern, outputLabel(rule, undefined, locale), rule.metadata] as const),
    ];
    if (families.length) {
      lines.push("", en ? "### Manually labeled rule coverage" : "### 人工标注的规则范围", "", en ? "These labels describe rules. The first matching rule applies to a model; a family label does not guarantee compatibility with future models." : "以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。", "",
        en ? "| Capability | Family label | Actual match | Declaration | Evidence |" : "| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |", "| --- | --- | --- | --- | --- |");
      for (const [feature, label, pattern, description, metadata] of families) {
        lines.push(`| ${feature} | ${cell(label)} | ${cell(pattern.toString())} | ${description} | ${evidenceLabel(metadata.evidence, locale)} |`);
      }
    }
    lines.push("");
  }
  lines.push(...(en
    ? ["## Custom endpoints", "", "`custom-cloud` and `custom-local` do not have built-in model recommendations. Enter the model name and transport supported by the service you use.", ""]
    : ["## 自定义端点", "", "`custom-cloud`（云端自定义端点）与 `custom-local`（本地模型端点）不维护内置型号推荐；用户填写实际服务提供的名称和协议。", ""]));
  return lines.join("\n");
}
