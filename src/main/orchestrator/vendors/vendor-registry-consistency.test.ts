// 厂商注册表 ↔ renderer 预设的跨层一致性校验。
//
// 锁的不是当前数据"长什么样"（顺序快照已钉），而是注册表结构的**不变量**：
// 新增厂商漏登记任一顺序表、presets 漏配 providerId、规则表 providerId 写错、
// 兜底规则不自造字面量……任何一处漂移都会在这里红。
// 放 main 目录的原因：tsconfig.main.json 不编译 src/main 测试文件，
// 不会把 renderer 的 custom-endpoint-state 拖进 main 编译面；
// presets 的 import 链顶层只有常量与函数定义，node 环境（vitest）加载安全。
import { describe, expect, test } from "vitest";
import {
  VENDOR_REGISTRY,
  REASONING_VENDOR_ORDER,
} from "../../../shared/vendor-registry";
import { UNKNOWN_REASONING_CAPABILITY } from "../../../shared/vendor-registry/fallback";
import { MODEL_PRESETS } from "../../../renderer/settings/api/presets";

describe("厂商注册表 — 结构不变量", () => {
  // ① capability.id 唯一且非空
  test("capability.id 唯一且非空", () => {
    const ids = VENDOR_REGISTRY.map((e) => e.capability.id);
    for (const id of ids) {
      expect(id, "capability.id 不得为空").toBeTruthy();
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ② displayName 唯一且非空
  test("displayName 唯一且非空", () => {
    const names = VENDOR_REGISTRY.map((e) => e.capability.displayName);
    for (const name of names) {
      expect(name, "displayName 不得为空").toBeTruthy();
    }
    expect(new Set(names).size).toBe(names.length);
  });

  // ③ 每厂商恰好 1 条兜底规则、位于数组末位、正则钉死 /.*/ 无标志
  //    （结构契约，不靠对象恒等识别"像兜底"）
  test("每厂商恰好 1 条表尾通配兜底规则且位于末位", () => {
    for (const entry of VENDOR_REGISTRY) {
      const rules = entry.reasoningRules;
      const last = rules[rules.length - 1];
      expect(
        last.modelPattern.source,
        `${entry.capability.id} 表尾规则必须是 /.*/ 通配`,
      ).toBe(".*");
      expect(last.modelPattern.flags, `${entry.capability.id} 表尾规则不得带标志`).toBe("");
      const wildcardCount = rules.filter(
        (r) => r.modelPattern.source === ".*" && r.modelPattern.flags === "",
      ).length;
      expect(
        wildcardCount,
        `${entry.capability.id} 通配兜底规则必须恰好 1 条`,
      ).toBe(1);
    }
  });

  // ④ 兜底 capability 恒等于共享单例 —— resolver 二轮跨家族兜底
  //    靠对象恒等跳过别家表尾；自造字面量会让恒等判断失效
  test("各厂商兜底规则引用同一全局单例", () => {
    for (const entry of VENDOR_REGISTRY) {
      const last = entry.reasoningRules[entry.reasoningRules.length - 1];
      expect(last.capability).toBe(UNKNOWN_REASONING_CAPABILITY);
    }
  });

  // ⑤ 每厂商所有规则的 providerId 与 capability.id 一致
  test("规则 providerId 与所属厂商 capability.id 一致", () => {
    for (const entry of VENDOR_REGISTRY) {
      for (const rule of entry.reasoningRules) {
        expect(rule.providerId).toBe(entry.capability.id);
      }
    }
  });

  // ⑥ 全部正则禁 g/y 标志 —— 带 lastIndex 状态的正则在
  //    resolver 反复 .test() 下产生非确定行为，一次封死
  test("全部规则正则禁用 g / y 标志", () => {
    for (const entry of REASONING_VENDOR_ORDER) {
      for (const rule of entry.reasoningRules) {
        expect(rule.modelPattern.global, `${entry.capability.id} 规则正则禁 g 标志`).toBe(false);
        expect(rule.modelPattern.sticky, `${entry.capability.id} 规则正则禁 y 标志`).toBe(false);
      }
    }
  });
});

describe("注册表 ↔ presets — 跨层一致性", () => {
  // 真实厂商预设（排除自定义端点伪条目）
  const builtinPresets = MODEL_PRESETS.filter((p) => !p.customEndpointMode);

  // ⑦ registry↔presets 按 providerId 双向覆盖，展示值一致；
  //    不比对 baseUrl —— presets 的是 UI 预填值、capability 的是运行时默认，设计上就不同
  test("每个注册表厂商都有 providerId 对应的预设，displayName 与 shortName 一致", () => {
    expect(builtinPresets.length).toBe(VENDOR_REGISTRY.length);
    for (const entry of VENDOR_REGISTRY) {
      const preset = builtinPresets.find((p) => p.providerId === entry.capability.id);
      expect(
        preset,
        `注册表厂商 ${entry.capability.id} 缺少对应预设（presets 漏配 providerId？）`,
      ).toBeDefined();
      expect(preset!.providerName).toBe(entry.capability.displayName);
      expect(preset!.shortName).toBe(entry.shortName);
    }
  });

  // ⑨ presets 的 providerId 唯一，custom 两 id 不得与内置 id 撞车
  test("presets 的 providerId 唯一且 custom 两 id 不与内置厂商撞车", () => {
    const ids = MODEL_PRESETS.map((p) => p.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    const builtinIds = new Set(VENDOR_REGISTRY.map((e) => e.capability.id));
    expect(builtinIds.has("custom-cloud")).toBe(false);
    expect(builtinIds.has("custom-local")).toBe(false);
  });
});

describe("双顺序表 — 完整排列不变量", () => {
  // ⑧ REASONING_VENDOR_ORDER 必须是 VENDOR_REGISTRY 成员集合的完整排列。
  //    职责分工：本不变量管"成员完整性"（新增厂商漏登记任一表即红），
  //    order-snapshot.test.ts 管"历史顺序兼容"（有人重排旧序才红）。
  test("REASONING_VENDOR_ORDER 是 VENDOR_REGISTRY 的完整排列（集合相等）", () => {
    expect(new Set(REASONING_VENDOR_ORDER)).toEqual(new Set(VENDOR_REGISTRY));
  });

  test("两表长度相等（无遗漏、无多余）", () => {
    expect(REASONING_VENDOR_ORDER.length).toBe(VENDOR_REGISTRY.length);
  });

  test("REASONING_VENDOR_ORDER 自身无重复成员", () => {
    expect(new Set(REASONING_VENDOR_ORDER).size).toBe(REASONING_VENDOR_ORDER.length);
  });
});
