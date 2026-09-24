// 推理兜底 capability 的全局唯一实例。
//
// resolver 用对象恒等（rule.capability !== UNKNOWN_REASONING_CAPABILITY）识别
// "表尾通配兜底"并跳过它，让第二轮跨家族匹配（托管端点场景，如方舟上跑
// glm-5.3）能继续往下找真实规则。因此所有厂商 entry 的表尾 /.*/ 兜底必须
// 引用本常量，绝不允许各自造结构相同的字面量——恒等判断会失效，
// 第二轮会误命中别家的兜底。
//
// 本文件不 import 任何运行时模块，是依赖图叶子，避免 commonjs 部分初始化
// 让厂商文件在模块加载期拿到 undefined。

import type { ReasoningCapability } from "./types";

export const UNKNOWN_REASONING_CAPABILITY: ReasoningCapability = {
  control: "none",
  requestStyle: "none",
  supportsDisable: false,
};
