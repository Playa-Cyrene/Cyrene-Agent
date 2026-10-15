import { describe, expect, it } from "vitest";
import { renderAdaptedModelsMarkdown } from "./catalog-doc";
import { validateModelCatalog } from "./validation";
import { defineVendor, legacyMetadata } from "./define-vendor";
import { GLM_REGISTRY } from "./entries/glm";
import { VENDOR_REGISTRY } from "./index";

function fixture() {
  return defineVendor({
    capability: { ...GLM_REGISTRY.capability, id: "sample", displayName: "演示厂商" },
    shortName: "演示",
    presetDefaults: { baseUrl: "https://example.com/v1", transport: "openai" },
    models: [
      { model: "sample-v1", recommendedFor: ["chat"] },
      { model: "sample-old", recommendedFor: [], note: "历史型号" },
    ],
    reasoningRules: [{
      modelPattern: /^sample-v1$/, modelInferencePattern: /^sample-v1$/,
      familyLabel: "演示系列（人工标签）",
      capability: { control: "toggle", requestStyle: "thinking-type", supportsDisable: true },
      metadata: legacyMetadata("既有推理规则"),
    }],
    samplingRules: [{
      modelPattern: /^sample-v1$/, diversity: true, requiresReasoningOff: true,
      maximumTemperature: 1.99, metadata: legacyMetadata("既有采样规则"),
    }],
    structuredOutputRules: [{
      id: "sample-json", transport: "openai", modelPattern: /^sample-v1$/,
      tier: "A", mode: "provider_json_schema", verification: "official",
      metadata: { status: "supported", evidence: {
        kind: "official", url: "https://example.com/schema", checkedAt: "2026-10-04", transports: ["openai"],
      } },
    }],
  });
}

describe("生成公开适配清单", () => {
  it("按预设协议的专用地址校验和显示推理、采样实测证据", () => {
    const entry = fixture();
    const metadata = { status: "supported" as const, evidence: {
      kind: "observed" as const, artifact: "docs/observations/sample.md", checkedAt: "2026-10-04",
      transport: "anthropic" as const, endpoint: "https://example.com/anthropic",
    } };
    const scoped = {
      ...entry,
      presetDefaults: { ...entry.presetDefaults, transport: "anthropic" as const, anthropicBaseUrl: "https://example.com/anthropic" },
      models: [{ ...entry.models[0], unknownCapabilities: [
        { feature: "structuredOutput" as const, transport: "anthropic" as const, note: "没有该协议的输出规则" },
      ] }],
      reasoningRules: entry.reasoningRules.map((rule) => rule.metadata ? { ...rule, metadata } : rule),
      samplingRules: entry.samplingRules.map((rule) => ({ ...rule, metadata })),
    };
    expect(validateModelCatalog([scoped])).toEqual([]);
    const output = renderAdaptedModelsMarkdown([scoped]);
    expect(output).not.toContain("证据未覆盖该端点");
    expect(output).toContain("预填地址：https://example.com/anthropic");
    expect(output).toContain("思考开关；可关闭");
    expect(output).toContain("仅关闭思考时");
  });

  it("区分协议、未知、历史证据和采样条件，保留历史型号与人工系列", () => {
    const output = renderAdaptedModelsMarkdown([fixture()]);
    expect(output).toContain("sample-v1 | 主模型");
    expect(output).toContain("sample-old | 非推荐");
    expect(output).toContain("历史未核验");
    expect(output).toContain("仅关闭思考时");
    expect(output).toContain("温度上限 1.99");
    expect(output).toContain("openai：JSON Schema");
    expect(output).toContain("anthropic：未知（提示词 JSON 回退）");
    expect(output).toContain("演示系列（人工标签）");
    expect(output).toContain("https://example.com/schema");
    expect(output).toContain("2026-10-04");
    expect(output).not.toContain("sample-v2");
    expect(output).toContain("工具支持：厂商级声明");
  });

  it("证据仅覆盖另一协议时显示证据不足，元数据不会伪装成全协议保证", () => {
    const entry = fixture();
    const rule = entry.structuredOutputRules[0];
    const scoped = { ...entry, structuredOutputRules: [{ ...rule, metadata: {
      status: "supported" as const,
      evidence: { kind: "official" as const, url: "https://example.com/other", checkedAt: "2026-10-04", transports: ["anthropic" as const] },
    } }] };
    expect(renderAdaptedModelsMarkdown([scoped])).toContain("openai：未知（已有规则，证据未覆盖该协议）");
    expect(validateModelCatalog([scoped])).toContain("sample.sample-v1.structuredOutput.openai: 缺少覆盖或明确未知说明");
  });

  it("文本中的分隔符不会破坏表格；固定换行且重复渲染一致", () => {
    const entry = fixture();
    const escaped = { ...entry, models: [{ model: "old|name\n<example>", recommendedFor: [] as const }] };
    const output = renderAdaptedModelsMarkdown([escaped]);
    expect(output).toContain("old\\|name &lt;example&gt;");
    expect(output).not.toContain("\r");
    expect(output.endsWith("\n")).toBe(true);
    expect(renderAdaptedModelsMarkdown([escaped])).toBe(output);
  });

  it("实测协议相同但端点不同时不能宣传默认官方端点已确认", () => {
    const entry = fixture();
    const scoped = { ...entry, structuredOutputRules: entry.structuredOutputRules.map((rule) => ({ ...rule, metadata: {
      status: "supported" as const,
      evidence: { kind: "observed" as const, artifact: "docs/observations/sample.md", checkedAt: "2026-10-04", transport: "openai" as const, endpoint: "https://proxy.example.com/v1" },
    } })) };
    expect(renderAdaptedModelsMarkdown([scoped])).toContain("openai：未知（已有规则，证据未覆盖该端点）");
    expect(validateModelCatalog([scoped])).toContain("sample.sample-v1.structuredOutput.openai: 缺少覆盖或明确未知说明");
  });

  it("实际清单公开已知缺口，不改变协议或补造支持", () => {
    const output = renderAdaptedModelsMarkdown(VENDOR_REGISTRY);
    const sol = output.split("\n").find((line) => line.startsWith("| gpt-6.1-sol |"))!;
    expect(sol).toContain("openai：未知（提示词 JSON 回退）");
    expect(sol).toContain("responses：未知（提示词 JSON 回退）");
    expect(output).toContain("deepseek-v4-flash-vision-exp | 非推荐");
    expect(output).toContain("kimi-k2.7-code-highspeed | 非推荐");
    expect(validateModelCatalog(VENDOR_REGISTRY)).toEqual([]);
  });
});

describe("贡献声明维护检查", () => {
  it("拒绝重复型号，并要求新推荐型号说明缺失能力", () => {
    const entry = fixture();
    const models = [
      ...entry.models,
      { model: "new-model", recommendedFor: ["chat" as const] },
      { model: "sample-v1", recommendedFor: [] as const },
    ];
    const errors = validateModelCatalog([{ ...entry, models }]);
    expect(errors).toContain("sample.sample-v1: 重复型号");
    expect(errors).toContain("sample.new-model.reasoning.openai: 缺少覆盖或明确未知说明");
    expect(errors).toContain("sample.new-model.sampling.openai: 缺少覆盖或明确未知说明");
    expect(errors).toContain("sample.new-model.structuredOutput.openai: 缺少覆盖或明确未知说明");
  });

  it("接受有说明的能力缺口，拒绝空说明", () => {
    const entry = fixture();
    const unknownCapabilities = (["reasoning", "sampling", "structuredOutput"] as const)
      .map((feature) => ({ feature, transport: "openai" as const, note: "等待核验" }));
    const models = [{ model: "new-model", recommendedFor: ["chat" as const], unknownCapabilities }];
    expect(validateModelCatalog([{ ...entry, models }])).toEqual([]);
    expect(validateModelCatalog([{ ...entry, models: [{ ...models[0], unknownCapabilities: [{ ...unknownCapabilities[0], note: "" }] }] }]))
      .toContain("sample.new-model.reasoning.openai: 未知能力说明不能为空");
  });

  it("官方证据需要有效链接、日期和适用协议", () => {
    const entry = fixture();
    const rules = entry.structuredOutputRules.map((rule) => ({ ...rule, metadata: {
      status: "supported" as const,
      evidence: { kind: "official" as const, url: "javascript:alert(1)", checkedAt: "2026-02-30", transports: [] },
    } }));
    const errors = validateModelCatalog([{ ...entry, structuredOutputRules: rules }]);
    expect(errors).toContain("sample.structuredOutput[0]: 官方证据需要有效 HTTP 链接、日期和适用协议");
  });
});
