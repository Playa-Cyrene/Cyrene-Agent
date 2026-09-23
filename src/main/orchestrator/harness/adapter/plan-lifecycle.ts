import * as fs from "fs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { ReviewRunStatus } from "../../../../shared/review-types";
import {
  clearPlanRecoveredFrom,
  completeExecution,
  getPlanPath,
  getPlanRecoveredFrom,
  getPlanState,
  supplementPlan,
} from "../../plan-mode";

const LOG_PREFIX = "[HarnessAdapter]";

/**
 * 构造 [PLAN_RECOVERY] 注入块：崩溃恢复的事实参考。
 * 与 [PLAN_CONTEXT] 的语义相对：[PLAN_CONTEXT] = 执行许可（"严格按计划执行"），
 * [PLAN_RECOVERY] = 事实参考（"先查证、再修订、重新审批"），两者绝不混用。
 * - EXECUTING 中断：附"不要假设未执行"警示，先查工作区再修订计划
 * - REVIEW 中断：附旧计划草稿全文，引导与用户确认后修订重审
 * - 计划文件已不存在（容错）：跳过全文，仍注入中断事实警示
 * 注入前先消费恢复标记（一次性），后续消息不重复注入。
 */
async function buildPlanRecoveryBlock(threadId: string): Promise<string | undefined> {
  const recoveredFrom = getPlanRecoveredFrom(threadId);
  if (!recoveredFrom) return undefined;
  clearPlanRecoveredFrom(threadId);

  const header = recoveredFrom === "EXECUTING"
    ? [
        "[PLAN_RECOVERY]",
        "上次已批准计划的执行被异常中断。不要假设计划尚未执行——部分步骤可能已经完成，包括有外部副作用的步骤。",
        "先检查 workspace / git diff / 当前状态，确认哪些步骤已经完成，再修订计划并重新提交审批。",
      ]
    : [
        "[PLAN_RECOVERY]",
        "上次计划在等待审批时被中断。以下为中断前的计划草稿，仅作事实参考。",
        "请与用户确认是否沿用或修订该计划；修订后需重新 write_plan 提交审批。",
      ];

  try {
    const planContent = await fs.promises.readFile(getPlanPath(threadId), "utf8");
    return [
      ...header,
      "以下为中断前的计划原文，仅作事实参考，不要直接继续执行：",
      "",
      planContent.trim(),
    ].join("\n");
  } catch {
    // 计划文件已不存在（workspace 移动/删除/清理）：不注入全文，保留中断事实警示
    console.warn(`${LOG_PREFIX} [Plan] recovery: plan file missing, inject interruption facts only`);
    return header.join("\n");
  }
}

/**
 * 计划模式生命周期（lifecycle）适配：只负责读取/推进计划状态和发送完成通知，
 * 不负责组装普通提示词，也不拥有计划状态本身（状态仍由 plan-mode 单例持有）。
 */
export async function preparePlanRunContext(input: {
  mode?: ConversationMode;
  threadId: string;
}): Promise<{
  planState: ReturnType<typeof getPlanState> | undefined;
  planContextBlock?: string;
}> {
  const participatesInPlanMode = input.mode === "code" || input.mode === "chat";
  if (participatesInPlanMode && getPlanState(input.threadId) === "PLAN_REVIEW") {
    // PLAN_REVIEW 收到新消息意味着用户继续讨论；先退回讨论态，再拍摄本次 run 的状态快照。
    supplementPlan(input.threadId);
    console.log(`${LOG_PREFIX} [Plan] new message during PLAN_REVIEW, back to PLAN_DISCUSSING`);
  }

  const planState = participatesInPlanMode ? getPlanState(input.threadId) : undefined;
  if (planState === "PLAN_DISCUSSING") {
    // 崩溃恢复后的首条消息：注入 [PLAN_RECOVERY] 事实参考（恢复后状态必然是 DISCUSSING）
    const recoveryBlock = await buildPlanRecoveryBlock(input.threadId);
    if (recoveryBlock) {
      return { planState, planContextBlock: recoveryBlock };
    }
    return { planState };
  }
  if (planState !== "EXECUTING") {
    return { planState };
  }

  try {
    // 读取磁盘是异步边界，必须在创建 run 快照前完成，避免快照缺少已批准计划。
    const planContent = await fs.promises.readFile(getPlanPath(input.threadId), "utf8");
    return {
      planState,
      planContextBlock: [
        "[PLAN_CONTEXT]",
        "用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：",
        "",
        planContent.trim(),
      ].join("\n"),
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} [Plan] read plan.md failed:`, err instanceof Error ? err.message : err);
    return { planState };
  }
}

export function completePlanRun(input: {
  mode?: ConversationMode;
  threadId: string;
  runId: string;
  runStatus: ReviewRunStatus;
  signal: AbortSignal;
  send: (event: BaseEvent) => void;
}): void {
  if (input.mode !== "code" && input.mode !== "chat") return;

  const finishedPlanPath = completeExecution(input.threadId);
  if (!finishedPlanPath) return;

  console.log(`${LOG_PREFIX} [Plan] execution finished, back to NORMAL, plan=${finishedPlanPath}`);
  // completeExecution 对成功、失败、取消都要调用；只有真正完成执行态才发送前端通知。
  if (input.signal.aborted) return;

  input.send({
    type: EventType.CUSTOM,
    name: "cyrene.plan.completed",
    value: { planPath: finishedPlanPath, runStatus: input.runStatus },
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);
}
