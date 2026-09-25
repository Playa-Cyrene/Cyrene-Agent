// 厂商注册表聚合层 —— 一厂商一文件（entries/），本文件只负责拼装与双顺序。
//
// 双顺序契约（两个顺序都是可观察行为，各自快照钉死，不能合并成一个表）：
//   - REASONING_VENDOR_ORDER 保持旧 shared/reasoning.ts 全局规则表的厂商排列
//     （chatgpt → claude → … → doubao → grok → gemini，后两家为新增追加）。
//     原因：resolver 第二轮"模型名跨家族推断"按全局顺序 first-match，
//     重排会改变托管端点场景的兜底命中结果。
//   - VENDOR_REGISTRY 保持旧 capabilities.ts 能力表的厂商排列
//     （minimax → … → mimo → grok → gemini，后两家为新增追加）。
//     原因：PROVIDER_CAPABILITIES 由本表 map 派生，导出数组顺序是可观察行为。
// 新增厂商必须在本文件两张顺序表各登记一次；一致性测试的完整排列不变量
// 会拦截漏登记，快照测试会拦截重排旧序。

import type { ModelReasoningRule, VendorRegistryEntry } from "./types";
import { CHATGPT_REGISTRY } from "./entries/chatgpt";
import { CLAUDE_REGISTRY } from "./entries/claude";
import { DEEPSEEK_REGISTRY } from "./entries/deepseek";
import { GLM_REGISTRY } from "./entries/glm";
import { QWEN_REGISTRY } from "./entries/qwen";
import { KIMI_REGISTRY } from "./entries/kimi";
import { MINIMAX_REGISTRY } from "./entries/minimax";
import { MIMO_REGISTRY } from "./entries/mimo";
import { DOUBAO_REGISTRY } from "./entries/doubao";
import { GROK_REGISTRY } from "./entries/grok";
import { GEMINI_REGISTRY } from "./entries/gemini";

// 厂商注册表：按旧 capabilities.ts 能力表顺序排列（minimax 开头），新厂商追加尾部。
// satisfies 只做结构检查、不改窄推断类型——typeof VENDOR_REGISTRY[number]
// 保持 11 个 entry 字面量类型的联合，BuiltinProviderId 才能推导出真正的 id 联合。
export const VENDOR_REGISTRY = [
  MINIMAX_REGISTRY,
  DEEPSEEK_REGISTRY,
  DOUBAO_REGISTRY,
  GLM_REGISTRY,
  KIMI_REGISTRY,
  QWEN_REGISTRY,
  CHATGPT_REGISTRY,
  CLAUDE_REGISTRY,
  MIMO_REGISTRY,
  GROK_REGISTRY,
  GEMINI_REGISTRY,
] satisfies readonly VendorRegistryEntry[];

// 内置厂商 id 联合类型：从注册表推导，不手写枚举——新增厂商自动进入，
// presets 写错 providerId 编译期即报。该推导类型只从本文件导出
// （types.ts 不反向 import 本文件），依赖图保持单向。
export type BuiltinProviderId =
  (typeof VENDOR_REGISTRY)[number]["capability"]["id"];

// 推理规则聚合顺序：与旧 shared/reasoning.ts 全局规则表逐字节一致（快照测试钉死）。
// 显式标注为 readonly VendorRegistryEntry[]：defineVendor 的 const 泛型会保留每个
// entry 的字面量类型，数组字面量会推断成 9 元异构 tuple，flatMap 无法在异构 tuple
// 上做泛型推断；本表只保规则顺序，字面量保真由 VENDOR_REGISTRY 的 satisfies 承担。
export const REASONING_VENDOR_ORDER: readonly VendorRegistryEntry[] = [
  CHATGPT_REGISTRY,
  CLAUDE_REGISTRY,
  DEEPSEEK_REGISTRY,
  GLM_REGISTRY,
  QWEN_REGISTRY,
  KIMI_REGISTRY,
  MINIMAX_REGISTRY,
  MIMO_REGISTRY,
  DOUBAO_REGISTRY,
  GROK_REGISTRY,
  GEMINI_REGISTRY,
];

export const MODEL_REASONING_RULES: readonly ModelReasoningRule[] =
  REASONING_VENDOR_ORDER.flatMap((entry) => entry.reasoningRules);

/**
 * 按厂商显示名查短名（去括号后缀）。参数仍是 displayName——过渡态：
 * 用户已保存配置的存储键在持久化迁移完成前仍是 displayName，改名需走
 * PROVIDER_RENAMES 迁移；迁移完成后可切换为按 providerId 查找。
 * 未命中返回 undefined，兜底逻辑（原样显示）留给调用方。
 */
export function getVendorShortName(displayName: string): string | undefined {
  return VENDOR_REGISTRY.find(
    (entry) => entry.capability.displayName === displayName,
  )?.shortName;
}
