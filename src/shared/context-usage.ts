// 上下文容量观看器的共享类型（main / preload / renderer 三端共用）。
//
// 快照由主进程在压缩前（preCompaction）、请求前（preRequest）与 run 终态（terminal）拍摄，
// riding 现有 AG-UI CUSTOM 事件 "cyrene.context.usage" 推送到渲染层：
// - preCompaction/preRequest 更新 renderer 内存态，圆环实时刷新；
// - terminal 包含最终 assistant 回复，随消息持久化（一次落盘）。

/** 六类分类 key；口径见 docs/context-usage-viewer-construction-plan.md。
 *  `toolDefinitions` 为旧快照兼容 key（拆分前"工具与 Skill"合一），仅渲染层识别，不再产出。 */
export type ContextUsageCategoryKey =
  | "systemPrompt"
  | "tools"
  | "skills"
  | "runtimeAndToolLogs"
  | "conversation"
  | "other"
  | "toolDefinitions";

export interface ContextUsageCategory {
  key: ContextUsageCategoryKey;
  tokens: number;
}

/** preCompaction = 压缩前的完整占用；preRequest = 本轮请求发出前；terminal = run 终态。 */
export type ContextUsagePhase = "preCompaction" | "preRequest" | "terminal";

export interface ContextUsageSnapshot {
  phase: ContextUsagePhase;
  /** 拍摄快照的 runId（chat 模式可缺省）。 */
  runId?: string;
  /** harness 轮次序号；chat 恒 0。 */
  round?: number;
  /** 模型档案的上下文窗口（Token）。 */
  contextWindowTokens: number;
  /** 估算总输入 token（= Σ categories）。 */
  totalTokens: number;
  categories: ContextUsageCategory[];
  /** 消息条数（含 internal/tool），便于排查膨胀来源。 */
  messageCount: number;
  updatedAt: number;
}

export interface ContextCompactionPhaseEvent {
  sessionId: string;
  phase: "running" | "finished";
  contextUsage?: ContextUsageSnapshot;
}

const CATEGORY_KEY_SET = new Set<string>([
  "systemPrompt",
  "tools",
  "skills",
  "runtimeAndToolLogs",
  "conversation",
  "other",
  // 旧快照兼容（拆分前合一计数），校验放行但新快照不再产出。
  "toolDefinitions",
]);

/** 渲染层事件负载校验；不通过一律忽略，绝不把脏数据写进消息。 */
export function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ContextUsageSnapshot>;
  if (snapshot.phase !== "preCompaction" && snapshot.phase !== "preRequest" && snapshot.phase !== "terminal") return false;
  if (typeof snapshot.contextWindowTokens !== "number" || !Number.isFinite(snapshot.contextWindowTokens)) return false;
  if (typeof snapshot.totalTokens !== "number" || !Number.isFinite(snapshot.totalTokens)) return false;
  if (typeof snapshot.messageCount !== "number" || !Number.isFinite(snapshot.messageCount)) return false;
  if (typeof snapshot.updatedAt !== "number" || !Number.isFinite(snapshot.updatedAt)) return false;
  if (!Array.isArray(snapshot.categories)) return false;
  return snapshot.categories.every(
    (category) => category && typeof category === "object"
      && typeof (category as ContextUsageCategory).key === "string"
      && CATEGORY_KEY_SET.has((category as ContextUsageCategory).key)
      && typeof (category as ContextUsageCategory).tokens === "number"
      && Number.isFinite((category as ContextUsageCategory).tokens),
  );
}
