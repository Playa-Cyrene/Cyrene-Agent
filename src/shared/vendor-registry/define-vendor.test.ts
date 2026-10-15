import { describe, expect, test } from "vitest";
import { defineVendor } from "./define-vendor";
import { GLM_REGISTRY } from "./entries/glm";
import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";

const metadata = {
  status: "supported",
  evidence: { kind: "legacy", note: "测试中的既有能力声明" },
} as const;

function entry(modelPattern = /^sample-v1$/) {
  return {
    capability: GLM_REGISTRY.capability,
    shortName: "GLM",
    reasoningRules: [{
      modelPattern,
      modelInferencePattern: /^sample-v1$/,
      familyLabel: "sample-v1 系列",
      metadata,
      capability: {
        control: "toggle",
        requestStyle: "thinking-type",
        supportsDisable: true,
      },
    }],
  } as const;
}

describe("厂商声明边界", () => {
  test("为真实规则补所属厂商，并追加共享兜底而不改变输入", () => {
    const input = entry();
    const vendor = defineVendor(input);
    expect(vendor.reasoningRules).toHaveLength(2);
    expect(vendor.reasoningRules[0].providerId).toBe("glm");
    expect(vendor.reasoningRules[0].modelPattern.test("sample-v1")).toBe(true);
    expect(vendor.reasoningRules[0].metadata).toBe(metadata);
    expect(vendor.reasoningRules[0].modelInferencePattern?.test("sample-v1")).toBe(true);
    expect(vendor.reasoningRules[0].familyLabel).toBe("sample-v1 系列");
    expect(vendor.reasoningRules[1].capability).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(vendor.reasoningRules[1].modelPattern.test("other-model")).toBe(true);
    expect(input.reasoningRules).toHaveLength(1);
  });

  test.each([/^sample/g, /^sample/y])("拒绝会影响重复匹配的状态正则 %s", (pattern) => {
    expect(() => defineVendor(entry(pattern))).toThrow(/glm.*reasoning.*0/);
  });

  test("推断匹配同样拒绝状态正则", () => {
    const input = entry();
    expect(() => defineVendor({
      ...input,
      reasoningRules: [{ ...input.reasoningRules[0], modelInferencePattern: /^sample/g }],
    })).toThrow(/glm.*reasoning.*0/);
  });

  test("拒绝贡献者手写厂商通配兜底", () => {
    expect(() => defineVendor(entry(/.*/))).toThrow(/glm.*reasoning.*0/);
  });

  test.each([/^.*$/, /^.*$/i, /^(?:.*)$/, /[\s\S]*/, /^[\s\S]*$/])("拒绝全匹配 %s 和复制的未知能力对象，保留跨厂商推断", (pattern) => {
    const input = entry(pattern);
    expect(() => defineVendor({
      ...input,
      reasoningRules: [{ ...input.reasoningRules[0], capability: { ...UNKNOWN_REASONING_CAPABILITY } }],
    })).toThrow(/glm.*reasoning.*0.*通配兜底/);
  });

  test("保留具体未知型号规则，兜底仍使用共享单例", () => {
    const input = entry();
    const vendor = defineVendor({
      ...input,
      reasoningRules: [{
        ...input.reasoningRules[0],
        capability: UNKNOWN_REASONING_CAPABILITY,
        metadata: { ...metadata, status: "unknown" },
      }],
    });
    expect(vendor.reasoningRules).toHaveLength(2);
    expect(vendor.reasoningRules[0].modelPattern.source).toBe("^sample-v1$");
    expect(vendor.reasoningRules[0].capability).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(vendor.reasoningRules[1].capability).toBe(UNKNOWN_REASONING_CAPABILITY);
  });
});
