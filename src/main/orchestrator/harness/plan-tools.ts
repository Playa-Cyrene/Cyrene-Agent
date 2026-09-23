/**
 * 计划模式工具组：enter_plan_mode / write_plan / submit_plan
 *
 * 与 ask_user 同属 harness builtin：控制流工具需要访问会话状态与事件，
 * 不走 toolRegistry 权限链（builtin 在 checkPermission 之前 dispatch）。
 * write_plan 是 PLAN_DISCUSSING 期间唯一合法写操作，只写 plan-mode 固定路径；
 * submit_plan 是交卷工具：写入过的计划提交用户审批，run 原地等待三档决定，
 * 决定作为工具结果回传（批准=同 run 开工，需要修改=回讨论改方案，不批准=退出计划模式）。
 */

import * as fs from "fs";
import * as path from "path";
import type { AskClarificationCard, AskUserAnswer } from "../../../shared/ask-clarification";
import type { ToolCall, ToolSpec } from "../vendors/types";
import type { HarnessEvent, ToolObservation } from "./types";
import { parseToolCallArgs } from "./types";
import type { ToolContext } from "../tools/registry/tool-context";
import { toastEvents } from "../../toast/toast-events";
import {
  approvePlan,
  enterPlanDiscussing,
  exitPlanMode,
  getPlanPath,
  getPlanState,
  hasPlanWrittenThisRun,
  markPlanWritten,
  moveToReview,
  supplementPlan,
} from "../plan-mode";

export const ENTER_PLAN_MODE_TOOL_ID = "enter_plan_mode";
export const WRITE_PLAN_TOOL_ID = "write_plan";
export const SUBMIT_PLAN_TOOL_ID = "submit_plan";

export const enterPlanModeToolSpec: ToolSpec = {
  name: ENTER_PLAN_MODE_TOOL_ID,
  description: [
    "进入计划模式：与用户讨论方案并产出可审批的实施计划。",
    "",
    "何时必须用：",
    "- 用户明确要求进入计划模式 / 说\"做个计划\"/\"先别动手\"/\"我们先讨论\"等意图时，必须调用本工具，不要自行判断\"任务太简单\"而跳过。",
    "",
    "何时优先考虑：",
    "- 涉及代码/文件改动，且非单次工具调用即可完成的任务。",
    "",
    "何时不用：",
    "- 单纯问答（直接回答）；单步小任务（一次工具调用即可完成且无副作用）；用户只要一段文字内容（直接写）。",
    "",
    "进入后：只能读取信息与讨论方案，修改类工具全部禁用；讨论收敛后用 write_plan 提交计划，用户批准后才会开始执行。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "一句话说明为什么这个请求值得先做计划（可选）" },
    },
    required: [],
  },
};

export const writePlanToolSpec: ToolSpec = {
  name: WRITE_PLAN_TOOL_ID,
  description: [
    "把完整实施计划写入计划文件（仅计划模式可用）。",
    "内容为 Markdown：目标、背景、任务清单（checkbox 列表，每项可独立验证）、风险与回退。",
    "整份计划经 content 参数传入，Runtime 落盘；讨论中方案有变时再次调用整份覆盖。",
    "写入本身不触发审批：讨论收敛后调用 submit_plan 提交用户审批。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "完整计划 Markdown 全文（含任务 checkbox 清单）" },
    },
    required: ["content"],
  },
};

export const submitPlanToolSpec: ToolSpec = {
  name: SUBMIT_PLAN_TOOL_ID,
  description: [
    "提交计划交用户审批（仅计划模式且本轮已 write_plan 时可用）。",
    "调用后运行会原地等待用户决定，结果作为工具结果返回：",
    "- 批准：立即开始执行计划",
    "- 需要修改：根据用户意见修订计划，write_plan 整份覆盖后再次 submit_plan",
    "- 不批准：退出计划模式，不再执行计划",
    "讨论尚未收敛时不要调用本工具；先与用户把方案聊透、write_plan 落盘，再交卷。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

function conversationIdOf(ctx?: ToolContext): string {
  return ctx?.conversationId ?? "default";
}

export async function executeEnterPlanMode(
  call: ToolCall,
  ctx: ToolContext | undefined,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const conversationId = conversationIdOf(ctx);
  // workspaceRoot 唯一可信来源是 ToolContext（Conversation Workspace Binding）
  const transition = enterPlanDiscussing(conversationId, ctx?.resolvedWorkspaceRoot);
  if (!transition.ok) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: ENTER_PLAN_MODE_TOOL_ID,
      message: transition.reason ?? "当前状态不可进入计划模式",
    };
  }
  onEvent?.({ type: "plan_mode_changed", state: "PLAN_DISCUSSING" });
  return {
    outcome: "success",
    tool: ENTER_PLAN_MODE_TOOL_ID,
    message:
      "已进入计划模式。后续只能读取信息、讨论方案，修改类工具已被禁用。" +
      "请与用户讨论方案；讨论收敛后，将完整计划（目标、任务 checkbox 清单、风险）通过 write_plan 写入并提交审批。",
  };
}

export async function executeWritePlan(
  call: ToolCall,
  ctx: ToolContext | undefined,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const conversationId = conversationIdOf(ctx);
  if (getPlanState(conversationId) !== "PLAN_DISCUSSING") {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: WRITE_PLAN_TOOL_ID,
      message: "write_plan 仅在计划讨论状态可用",
    };
  }
  const args = parseToolCallArgs(call);
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: WRITE_PLAN_TOOL_ID,
      message: "content 必须是非空的计划 Markdown",
    };
  }

  const planPath = getPlanPath(conversationId);
  try {
    await fs.promises.mkdir(path.dirname(planPath), { recursive: true });
    await fs.promises.writeFile(planPath, content, "utf8");
  } catch (err) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: WRITE_PLAN_TOOL_ID,
      message: `计划文件写入失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  markPlanWritten(conversationId);
  onEvent?.({ type: "plan_written", planPath });
  return {
    outcome: "success",
    tool: WRITE_PLAN_TOOL_ID,
    target: planPath,
    message: `计划已写入 ${planPath}。讨论收敛后调用 submit_plan 提交用户审批；如需继续修改方案，再次调用本工具整份覆盖。`,
  };
}

/**
 * 执行 submit_plan：交卷并原地等待三档审批，用户决定作为工具结果回传（同 run 继续，不新开 run）。
 * 状态迁移全部在 runtime 内完成：moveToReview（交卷）→ approvePlan / supplementPlan / exitPlanMode（三档）。
 * moveToReview 是 durable transition：返回时 state.json 已落盘，等待中崩溃按 P1 语义统一降级恢复。
 * 等待中用户取消（abort）：raceWithSignal 在排他轮拦截，本函数的等待被遗弃，
 * REVIEW 残留由用户下条消息经 preparePlanRunContext 拉回讨论态（审批被中断的事实本身）。
 */
export async function executeSubmitPlan(
  _call: ToolCall,
  ctx: ToolContext | undefined,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const conversationId = conversationIdOf(ctx);
  const runId = ctx?.runId ?? "";
  // 状态守卫：仅讨论态可交卷。REVIEW=重复交卷、EXECUTING=执行中、NORMAL=未进计划模式，一律拒绝
  if (getPlanState(conversationId) !== "PLAN_DISCUSSING") {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "submit_plan 仅在计划讨论状态可用",
    };
  }
  if (!hasPlanWrittenThisRun(conversationId)) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "本轮尚未 write_plan，请先写入计划再提交审批",
    };
  }
  if (!requestUserClarification) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "requestUserClarification 函数未注入，无法提交审批",
    };
  }
  // 交卷：DISCUSSING → REVIEW（durable 落盘后才发起等待）
  if (!moveToReview(conversationId)) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "计划状态异常，无法提交审批",
    };
  }

  const planPath = getPlanPath(conversationId);
  let planContent = "";
  try {
    planContent = await fs.promises.readFile(planPath, "utf8");
  } catch (err) {
    // 读不到计划全文不能让用户盲批：拉回讨论态，让模型重写落盘后再交卷
    supplementPlan(conversationId);
    toastEvents.publishPlanReviewEnded({ sessionId: conversationId, runId });
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: `计划文件读取失败，无法提交审批：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 计划全文经独立事件下发（渲染端打开计划面板）；审批卡走 ask 卡通道等待
  onEvent?.({ type: "plan_submitted", conversationId, planPath, planContent });
  // 注意力提醒：先于审批卡发布，ToastService 据此把同 runId 的 choice 卡归类为 plan-review，避免双弹
  toastEvents.publishPlanReview({ sessionId: conversationId, runId });

  const answer = await requestUserClarification(buildPlanApprovalCard(planPath)) as AskUserAnswer;
  const decision = answer.answers.find((a) => a.field === "plan_decision");

  // 批准：REVIEW → EXECUTING。回执自带计划全文——同 run 原地开工，run 上下文里没有
  // [PLAN_CONTEXT] 注入块，执行许可必须由工具结果自带给模型
  if (decision?.selectedValues?.includes("approve") && approvePlan(conversationId)) {
    toastEvents.publishPlanApproved({ sessionId: conversationId, runId });
    return {
      outcome: "success",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: [
        "用户已批准该计划，现在开始执行。",
        "请严格按计划清单顺序执行，用 update_todo 维护任务进度。",
        "以下是批准的计划全文：",
        "",
        planContent.trim(),
      ].join("\n"),
    };
  }

  // 需要修改：REVIEW → DISCUSSING，收意见全文后回执带修订指引
  if (decision?.selectedValues?.includes("revise")) {
    supplementPlan(conversationId);
    const reviseAnswer = await requestUserClarification(buildPlanReviseCard()) as AskUserAnswer;
    const reviseText = reviseAnswer.answers.find((a) => a.field === "plan_revise")?.customText?.trim();
    // 第二段结算即计划流终点（无论是否填意见），清理注意力提醒（幂等）
    toastEvents.publishPlanReviewEnded({ sessionId: conversationId, runId });
    if (reviseText) {
      return {
        outcome: "success",
        tool: SUBMIT_PLAN_TOOL_ID,
        message: [
          "用户要求先修改计划，再重新提交审批。修改意见如下：",
          "",
          reviseText,
          "",
          "请根据意见修订计划，调用 write_plan 整份覆盖后，再调用 submit_plan 重新提交。",
        ].join("\n"),
      };
    }
    // 未填意见（第二段超时/空答案）：回讨论态等用户消息，模型引导用户说清要改什么
    return {
      outcome: "success",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "用户选择了需要修改，但未填写具体意见，已回到计划讨论状态。请与用户确认要修改的内容。",
    };
  }

  // 不批准：退出计划模式。计划文件保留（项目资产），回执明确禁止执行
  if (decision?.selectedValues?.includes("reject")) {
    exitPlanMode(conversationId);
    toastEvents.publishPlanReviewEnded({ sessionId: conversationId, runId });
    return {
      outcome: "success",
      tool: SUBMIT_PLAN_TOOL_ID,
      message: "用户否决了该计划，已退出计划模式。不要执行计划中的任何步骤。请询问用户接下来想如何处理。",
    };
  }

  // 超时/空答案：拉回讨论态等用户回来。绝不默认批准，也不默认否决
  supplementPlan(conversationId);
  toastEvents.publishPlanReviewEnded({ sessionId: conversationId, runId });
  return {
    outcome: "success",
    tool: SUBMIT_PLAN_TOOL_ID,
    message: "等待审批超时，已回到计划讨论状态。计划文件已保留，用户下次回复后可继续讨论；讨论收敛后可重新提交审批。",
  };
}

/**
 * 计划审批卡（三档：批准 / 需要修改 / 不批准）。
 * 过渡形态：复用 single_select 协议，渲染端以现有单选卡样式呈现；
 * 第二批施工替换为专属三按钮卡片 UI（原地展开输入框 + Ctrl+Enter 提交）。
 * 等待档位 plan_approval：审批要通读计划，超时用 planApprovalTimeout 而非快问快答配置。
 */
export function buildPlanApprovalCard(planPath: string): AskClarificationCard & { planPath: string } {
  return {
    mode: "semantic_clarification",
    intro: "计划已提交，请审阅计划内容后决定",
    questions: [
      {
        field: "plan_decision",
        question: "是否批准此计划？",
        type: "single_select",
        options: [
          { label: "批准", value: "approve" },
          { label: "需要修改", value: "revise" },
          { label: "不批准", value: "reject" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "",
      },
    ],
    deferredFields: [],
    waitTimeoutTone: "plan_approval",
    planPath,
  };
}

/**
 * 计划修改意见卡（"需要修改"后的第二段，纯文本输入，复用同一 ask 卡片样式）。
 * 等待档位同为 plan_approval：写修改意见不是快问快答。
 */
export function buildPlanReviseCard(): AskClarificationCard {
  return {
    mode: "semantic_clarification",
    intro: "请描述你想修改的内容，我会更新计划后再次提交审批",
    questions: [
      {
        field: "plan_revise",
        question: "请描述你的修改意见：",
        type: "text",
        options: [],
        allowCustom: true,
        freeTextPlaceholder: "例如：第三步改成先写测试；补充一个回滚方案…",
      },
    ],
    deferredFields: [],
    waitTimeoutTone: "plan_approval",
  };
}
