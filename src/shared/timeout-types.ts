export type TimeoutSettings = {
  chatRequestTimeout: number,
  userChoiceTimeout: number,
  /** 计划审批卡专用等待时长：审批是重决策（要通读整份计划），不能沿用快问快答的 60s。 */
  planApprovalTimeout: number,
  testTimeout: number,
  /** 旧结构化输出策略仍读取；不再暴露为用户设置。 */
  profileMinimumRemainingBudgetMs: number,
  /** 模型请求超时（秒），所有非流式 Structured Output 调用统一使用 */
  modelRequestTimeoutSec?: number,
}
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量
export const DEFAULT_TIMEOUT_SETTINGS: TimeoutSettings = {
  testTimeout: 15000,
  chatRequestTimeout: DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
  userChoiceTimeout: 60000,
  planApprovalTimeout: 600000,
  profileMinimumRemainingBudgetMs: -1,
};
