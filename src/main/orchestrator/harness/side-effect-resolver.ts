/**
 * 副作用解析器：把现有 ToolDefinition.effectKind / effectResolver 映射到 Harness 的 SideEffectKind。
 * 现有 effectKind: read / mutation / verification / external_side_effect / unknown
 * Harness SideEffectKind: read_only / idempotent_mutation / non_idempotent_side_effect
 */

import type { ToolDefinition } from "../tools/registry/tool-registry";
import { resolveEffectKind } from "../tools/registry/tool-registry";
import type { SideEffectKind } from "./types";

/** 静态映射表：旧 effectKind → 新 SideEffectKind */
const EFFECT_KIND_MAP: Record<string, SideEffectKind> = {
  read: "read_only",
  // 验证意图 ≠ 无副作用：build/test/lint 会产 dist/coverage/snapshot、执行项目脚本，
  // 必须退出并发 read 池；但通常可安全重跑（transient/timeout 可重试），不是不可重放的外部副作用
  verification: "idempotent_mutation",
  mutation: "idempotent_mutation",
  external_side_effect: "non_idempotent_side_effect",
  // fail-closed：不知道它干什么，就按最危险的对待——不自动重试、不计入并发
  unknown: "non_idempotent_side_effect",
};

/**
 * 解析工具调用的副作用分类。
 * 优先使用 tool.effectResolver（动态），其次 tool.effectKind（静态）；
 * 无工具或返回非法值时按最危险处理（fail-closed），不静默放行。
 */
export function resolveSideEffect(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): SideEffectKind {
  const effectKind = resolveEffectKind(tool, args);
  return EFFECT_KIND_MAP[effectKind] ?? "non_idempotent_side_effect";
}
