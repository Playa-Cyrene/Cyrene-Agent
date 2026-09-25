// 会话级模型解析四件套（方案：模型档案多模型 + 对话级模型选择）。
//
// 这是唯一语义源：所有会话感知消费点（文本/图片/reasoning/agent run/标题）
// 一律消费这里的 effective 结果，禁止各处手写 `session.model ?? profile.model`。
//
// 类型刻意用最小结构（结构兼容 ProviderProfile / SavedModelProfile / ChatSession），
// 让 main 与 renderer 都能引用而不产生层级倒置。
//
// 不变量（判定规则见方案文档）：
//   Invariant B：session.model 从属于 session.modelProfileId；绑定失效时一并失效。
//   Invariant C：runtime 与 UI 只认 effective；raw session.model 仅存储不清清理。

import type { ManualReasoningConfig } from "./manual-reasoning";

/** 会话侧解析输入的最小结构（ChatSession 结构兼容）。 */
export interface SessionModelBindingInput {
  modelProfileId?: string;
  model?: string;
}

/** 档案侧解析输入的最小结构（ProviderProfile / SavedModelProfile 结构兼容）。 */
export interface SessionModelProfileView {
  id: string;
  model: string;
  /** 档案内可切换的模型清单；缺省 = 单模型档案（行为与旧档案一致）。 */
  models?: string[];
  /** 模型专属能力；旧档案没有此字段时沿用档案级兼容值。 */
  modelOptions?: Record<string, { multimodal?: boolean; contextWindowTokens?: number; manualReasoning?: ManualReasoningConfig }>;
  contextWindowTokens?: number;
  multimodal?: boolean;
}

/** 配置侧解析输入的最小结构（ModelSettings 结构兼容）。 */
export interface SessionModelSettingsView {
  modelProfiles?: SessionModelProfileView[];
  defaultModelProfileId?: string;
}

/**
 * ① 档案可选模型（单一定义点）。
 * 单模型档案（无 models 或空清单）= [profile.model]，与旧档案行为完全一致。
 */
export function getProfileSelectableModels(profile: Pick<SessionModelProfileView, "model" | "models">): string[] {
  return profile.models?.length ? profile.models : [profile.model];
}

/**
 * ② 档案绑定解析（provenance 起点：命中还是回退，不许在后续解析中丢掉）。
 * - session.modelProfileId 命中已存档案 → bindingMatched = true
 * - 无绑定（旧会话）/ 绑定失效（档案已删）→ 回退默认档案链，bindingMatched = false
 * - 一个档案都没有 → profile = undefined（消费方回退全局配置，保持旧行为）
 */
export interface ResolvedSessionProfileBinding {
  profile: SessionModelProfileView | undefined;
  /** 实际解析到的档案 id（可能是回退档案）；无档案时为 undefined。 */
  resolvedProfileId: string | undefined;
  /** session.modelProfileId 命中原绑定档案 = true；无绑定或回退 = false。 */
  bindingMatched: boolean;
}

export function resolveSessionProfileBinding(
  settings: SessionModelSettingsView,
  session: SessionModelBindingInput,
): ResolvedSessionProfileBinding {
  const profiles = settings.modelProfiles ?? [];
  const bound = session.modelProfileId
    ? profiles.find((item) => item.id === session.modelProfileId)
    : undefined;
  if (bound) {
    return { profile: bound, resolvedProfileId: bound.id, bindingMatched: true };
  }
  const fallback = profiles.find((item) => item.id === settings.defaultModelProfileId) ?? profiles[0];
  if (!fallback) {
    return { profile: undefined, resolvedProfileId: undefined, bindingMatched: false };
  }
  return { profile: fallback, resolvedProfileId: fallback.id, bindingMatched: false };
}

/**
 * ③ 会话级 effective model（Invariant C；吃 binding 不吃裸 profile）。
 * - 命中原绑定 且 session.model ∈ 档案可选清单 → session.model
 * - 否则 → 解析所得档案的默认模型（raw 值不清理，档案清单恢复后自动复活）
 */
export function resolveEffectiveSessionModel(
  session: SessionModelBindingInput,
  binding: ResolvedSessionProfileBinding,
): string | undefined {
  if (!binding.profile) return undefined;
  if (binding.bindingMatched && session.model) {
    const selectable = getProfileSelectableModels(binding.profile);
    if (selectable.includes(session.model)) return session.model;
  }
  return binding.profile.model;
}

/**
 * 会话模型写入的校验与目标状态计算（窄 IPC 的纯函数核心，决策 13）。
 * - validator 唯一规则：model ∈ 解析档案的 selectableModels（不留 free-form 旁门）
 * - stale binding（绑定失效/无绑定）时，用户主动选择 = 确认接受回退档案，
 *   原子修复绑定为回退档案 id；命中原绑定时保持不动
 * 返回的 { modelProfileId, model } 由主进程在 per-session 队列中原子写入。
 */
export type SessionModelUpdatePlan =
  | { ok: true; modelProfileId: string | undefined; model: string }
  | { ok: false; error: "no-profile" | "invalid-model" };

export function planSessionModelUpdate(
  settings: SessionModelSettingsView,
  session: SessionModelBindingInput,
  requestedModel: string,
): SessionModelUpdatePlan {
  const binding = resolveSessionProfileBinding(settings, session);
  if (!binding.profile) return { ok: false, error: "no-profile" };
  if (!getProfileSelectableModels(binding.profile).includes(requestedModel)) {
    return { ok: false, error: "invalid-model" };
  }
  return {
    ok: true,
    // 命中原绑定 → 保持原值；stale/无绑定 → 修复为回退档案（首次主动选择进入快照语义）
    modelProfileId: binding.bindingMatched ? session.modelProfileId : binding.resolvedProfileId,
    model: requestedModel,
  };
}
