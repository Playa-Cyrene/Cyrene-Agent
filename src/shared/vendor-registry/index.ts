// 厂商注册表聚合层 —— 一厂商一文件（entries/），本文件只负责拼装与顺序。
//
// 顺序契约：REASONING_VENDOR_ORDER 必须保持旧 shared/reasoning.ts 全局规则表的
// 厂商排列（chatgpt → claude → deepseek → glm → qwen → kimi → minimax → mimo → doubao）。
// 原因：resolver 第二轮"模型名跨家族推断"按全局顺序 first-match，厂商排列顺序
// 是可观察行为，重排会改变托管端点场景的兜底命中结果。
// 聚合顺序由 order-snapshot.test.ts 逐字节钉死；新增厂商必须在
// REASONING_VENDOR_ORDER 与（capability 迁入后的）VENDOR_REGISTRY 两处登记，
// 一致性测试会拦截漏登记。

import type { ModelReasoningRule, VendorReasoningEntry } from "./types";
import { CHATGPT_REGISTRY } from "./entries/chatgpt";
import { CLAUDE_REGISTRY } from "./entries/claude";
import { DEEPSEEK_REGISTRY } from "./entries/deepseek";
import { GLM_REGISTRY } from "./entries/glm";
import { QWEN_REGISTRY } from "./entries/qwen";
import { KIMI_REGISTRY } from "./entries/kimi";
import { MINIMAX_REGISTRY } from "./entries/minimax";
import { MIMO_REGISTRY } from "./entries/mimo";
import { DOUBAO_REGISTRY } from "./entries/doubao";

// 推理规则聚合顺序：与旧 shared/reasoning.ts 全局规则表逐字节一致（快照测试钉死）。
// 显式标注为 readonly VendorReasoningEntry[]：defineVendor 的 const 泛型会保留每个
// entry 的字面量类型，数组字面量会推断成 9 元异构 tuple，flatMap 无法在异构 tuple
// 上做泛型推断；本表只需保规则顺序，字面量保真留给阶段②的 VENDOR_REGISTRY。
export const REASONING_VENDOR_ORDER: readonly VendorReasoningEntry[] = [
  CHATGPT_REGISTRY,
  CLAUDE_REGISTRY,
  DEEPSEEK_REGISTRY,
  GLM_REGISTRY,
  QWEN_REGISTRY,
  KIMI_REGISTRY,
  MINIMAX_REGISTRY,
  MIMO_REGISTRY,
  DOUBAO_REGISTRY,
];

export const MODEL_REASONING_RULES: readonly ModelReasoningRule[] =
  REASONING_VENDOR_ORDER.flatMap((entry) => entry.reasoningRules);
