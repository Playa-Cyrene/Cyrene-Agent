import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";
import type { ModelReasoningRule } from "./types";
import type { RuleMetadata, VendorRegistryInput } from "./model-types";

/** 历史表搬迁的标记；新增能力应提供官方资料或脱敏实测。 */
export function legacyMetadata(note: string, status: RuleMetadata["status"] = "supported"): RuleMetadata {
  return { status, evidence: { kind: "legacy", note } };
}

function assertPattern(pattern: RegExp, location: string): void {
  if (pattern.global || pattern.sticky) {
    throw new Error(`${location}: 模型匹配正则禁止 g/y 标志`);
  }
  // 拦截常见的全匹配等价写法；不尝试证明任意正则之间的交集。
  let source = pattern.source;
  let previous: string;
  do {
    previous = source;
    source = source.replace(/^\^/, "").replace(/\$$/, "").replace(/^\((?:\?:)?([\s\S]*)\)$/, "$1");
  } while (source !== previous);
  if ([".*", ".+", "[\\s\\S]*", "[\\s\\S]+", "[\\S\\s]*", "[\\S\\s]+", "[^]*", "[^]+"].includes(source)) {
    throw new Error(`${location}: 通配兜底由厂商声明函数自动提供`);
  }
}

/** 保留厂商标识字面量，同时将内部关联与共享兜底从贡献输入中移除。 */
export function defineVendor<const T extends VendorRegistryInput>(entry: T):
  Omit<T, "reasoningRules"> & { reasoningRules: readonly ModelReasoningRule[] } {
  const providerId = entry.capability.id;
  for (const [index, rule] of entry.reasoningRules.entries()) {
    const location = `${providerId}.reasoning[${index}]`;
    assertPattern(rule.modelPattern, location);
    if (rule.modelInferencePattern) assertPattern(rule.modelInferencePattern, location);
  }
  for (const [kind, rules] of [
    ["sampling", entry.samplingRules ?? []],
    ["structuredOutput", entry.structuredOutputRules ?? []],
  ] as const) {
    for (const [index, rule] of rules.entries()) {
      assertPattern(rule.modelPattern, `${providerId}.${kind}[${index}]`);
    }
  }
  for (const [index, rule] of (entry.structuredOutputRules ?? []).entries()) {
    for (const override of rule.repairOverrides ?? []) {
      assertPattern(override.modelPattern, `${providerId}.structuredOutput[${index}].repair`);
    }
  }
  return {
    ...entry,
    reasoningRules: [
      ...entry.reasoningRules.map((rule) => ({ ...rule, providerId })),
      { providerId, modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
    ],
  };
}
