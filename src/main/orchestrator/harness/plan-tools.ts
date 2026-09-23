/**
 * 计划模式工具组：enter_plan_mode / write_plan
 *
 * 与 ask_user 同属 harness builtin：控制流工具需要访问会话状态与事件，
 * 不走 toolRegistry 权限链（builtin 在 checkPermission 之前 dispatch）。
 * write_plan 是 PLAN_DISCUSSING 期间唯一合法写操作，只写 plan-mode 固定路径。
 */

import * as fs from "fs";
import * as path from "path";
import type { AskClarificationCard } from "../../../shared/ask-clarification";
import type { ToolCall, ToolSpec } from "../vendors/types";
import type { HarnessEvent, ToolObservation } from "./types";
import { parseToolCallArgs } from "./types";
import type { ToolContext } from "../tools/registry/tool-context";
import {
  enterPlanDiscussing,
  getPlanPath,
  getPlanState,
  markPlanWritten,
} from "../plan-mode";

export const ENTER_PLAN_MODE_TOOL_ID = "enter_plan_mode";
export const WRITE_PLAN_TOOL_ID = "write_plan";

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
    "整份计划经 content 参数传入，Runtime 落盘并提交用户审批；需要修改时再次调用整份覆盖。",
    "写入后本轮继续正常收尾，用户会在你回复结束后看到审批卡片。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "完整计划 Markdown 全文（含任务 checkbox 清单）" },
    },
    required: ["content"],
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
    message: `计划已写入 ${planPath}，本轮收尾后将提交用户审批。如需修改请再次调用整份覆盖。`,
  };
}

/** 计划审批卡片（第一段，两选项、无自由输入；计划全文经 cyrene.plan.review 事件下发）。 */
export function buildPlanReviewCard(planPath: string): AskClarificationCard & { planPath: string } {
  return {
    mode: "semantic_clarification",
    intro: "计划已生成，请审阅右侧计划内容后决定",
    questions: [
      {
        field: "plan_decision",
        question: "是否批准此计划？",
        type: "single_select",
        options: [
          { label: "批准计划，开始执行", value: "approve" },
          { label: "我要修改 / 补充", value: "supplement" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "",
      },
    ],
    deferredFields: [],
    planPath,
  };
}

/** 计划补充卡片（第二段，纯文本输入，复用同一 ask 卡片样式）。 */
export function buildPlanSupplementCard(): AskClarificationCard {
  return {
    mode: "semantic_clarification",
    intro: "请在下方描述你想补充或修改的内容，我会更新计划后再次提交",
    questions: [
      {
        field: "plan_supplement",
        question: "请描述你的补充：",
        type: "text",
        options: [],
        allowCustom: true,
        freeTextPlaceholder: "例如：第三步改成先写测试；补充一个回滚方案…",
      },
    ],
    deferredFields: [],
  };
}
