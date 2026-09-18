/**
 * 工具审批（per-action 档位）载荷类型的唯一声明。
 *
 * 为什么放在 shared：同一份载荷有三个角色 —— 主进程发送、preload 透传、
 * 渲染端消费。曾经三处各写一份，preload 那份就漏了 `runId`（运行时靠整对象透传
 * 碰巧正确，一旦有人在 preload 里做字段挑选就会静默丢失）。共享一份即可根治。
 */

/** 工具风险等级：由主进程策略层判定，跨进程只做展示。 */
export type ToolRiskLevel =
  | "safe"
  | "fs-read"
  | "fs-write"
  | "shell"
  | "network"
  | "input-control";

/** 审批请求：主进程推送、渲染端展示并回传决定。 */
export interface ApprovalRequest {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
  /** 可选 runId，用于 run 取消时按 run 清理。 */
  runId?: string;
}

/** 结算原因。 */
export type ApprovalSettleReason = "answered" | "cancelled" | "unavailable";

/** 审批结算广播：pending 已在主进程结算，渲染端据此清卡。 */
export interface ApprovalSettledPayload {
  id: string;
  runId?: string;
  reason: ApprovalSettleReason;
}
