/**
 * Harness 内置工具：update_todo（任务清单） / ask_user（澄清提问）
 *
 * 这两个工具不进 toolRegistry，由 Harness Loop 内部 dispatch。
 * 它们能直接访问 AgentState 和事件发送器。
 */

import type { ToolCall } from "../vendors/types";
import type { ToolSpec } from "../vendors/types";
import type {
  AgentState,
  HarnessEvent,
  TodoItem,
  TodoStatus,
  ToolObservation,
} from "./types";
import { parseToolCallArgs } from "./types";
import { isAbortError } from "../../abort-utils";
import { resolveUncertainEffect } from "./uncertain-effect-guard";
import type { TaskExecuteRequest, TaskExecuteResult } from "../task-runtime";
import { buildGoldenDescendantsPrompt, getGoldenDescendantNames } from "../../tasks/task-character-pool";
import { READ_TOOL_RESULT_TOOL_ID, readToolResultToolSpec } from "./tool-output/read-tool-result";
import { ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID, enterPlanModeToolSpec, writePlanToolSpec } from "./plan-tools";

// ── update_todo ──────────────────────────────────────────

export const UPDATE_TODO_TOOL_ID = "update_todo";
export const TASK_TOOL_ID = "task";

const goldenDescendantNames = getGoldenDescendantNames();
const hasGoldenDescendants = goldenDescendantNames.length > 0;

export const taskToolSpec: ToolSpec = {
  name: TASK_TOOL_ID,
  description: [
    "委托一个需要独立上下文、多步执行的前台子任务。",
    "何时用：多个互不依赖的调查方向可以并行；较大目录或多个模块的独立审查；有明确交付物的专项任务。",
    "何时不用：一句话能回答的；只需一次工具调用的。",
    buildGoldenDescendantsPrompt(),
    "父任务会等待结果；description 只用于向用户显示委托标签，prompt 是子任务完整指令。可传 task_id 继续同一子任务。子任务不能询问用户或再次委托。",
  ].filter(Boolean).join(""),
  parameters: { type: "object", properties: {
    description: { type: "string", description: "给用户显示的 3-40 字任务标签" },
    prompt: { type: "string", description: "子任务完整执行指令" },
    subagent_type: { type: "string", enum: ["general", "document", "search"] },
    ...(hasGoldenDescendants ? {
      companion_id: { type: "string", enum: [...goldenDescendantNames], description: "本次委托的黄金裔名字；必须明确选择一位" },
    } : {}),
    task_id: { type: "string", description: "可选：恢复此前同一子任务" },
  }, required: ["description", "prompt", "subagent_type", ...(hasGoldenDescendants ? ["companion_id"] : [])] },
};

export async function executeTask(
  call: ToolCall,
  executor: ((request: TaskExecuteRequest) => Promise<TaskExecuteResult>) | undefined,
): Promise<ToolObservation> {
  if (!executor) return { outcome: "failure", category: "runtime_safety", tool: TASK_TOOL_ID, message: "TaskRuntime 未注入，当前运行不能委托子任务" };
  const args = parseToolCallArgs(call);
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const subagentType = args.subagent_type;
  const companionId = typeof args.companion_id === "string" ? args.companion_id.trim() : "";
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() || undefined : undefined;
  if (description.length < 3 || description.length > 40 || !prompt
    || !companionId
    || (subagentType !== "general" && subagentType !== "document" && subagentType !== "search")) {
    return { outcome: "failure", category: "invalid_arguments", tool: TASK_TOOL_ID, message: "task 需要 3-40 字 description、非空 prompt、合法 subagent_type 与明确 companion_id" };
  }
  const result = await executor({ description, prompt, subagentType, companionId, taskId });
  return { outcome: result.status === "completed" ? "success" : "failure", tool: TASK_TOOL_ID,
    message: `子任务"${description}"已${result.status === "completed" ? "完成" : result.status}。`,
    output: JSON.stringify({ taskId: result.taskId, status: result.status, text: result.text }) };
}

export const updateTodoToolSpec: ToolSpec = {
  name: UPDATE_TODO_TOOL_ID,
  description:
    "更新可变工作笔记（Todo）。传入完整的新 TodoItem 数组（整表替换）。\n" +
    "何时使用：预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次）时，优先建立并持续更新清单；不按 LLM 调用次数计算。\n" +
    "不要用于简单问答、纯闲聊或单次工具即可完成的任务。Todo 是可随事实和改变方向而重写的工作笔记，不是后续行动的强约束，也不是外部操作已经成功的证明。\n" +
    "规则：\n" +
    "- id 必须唯一\n" +
    "- 同一时刻最多一个 in_progress\n" +
    "- 状态转移：pending → in_progress → completed/cancelled；pending 也可直接 completed/cancelled（一轮内可批量收尾多条，无需逐条经过 in_progress）\n" +
    "- 不要把已 completed/cancelled 的任务改回 pending\n" +
    "Runtime 会校验并修正违规，修正后的实际列表会回告给你。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整的新待办列表（替换旧列表）",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "唯一标识" },
            content: { type: "string", description: "任务描述" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "任务状态",
            },
            activeForm: { type: "string", description: "正在进行时的现在时描述（可选）" },
          },
          required: ["id", "content", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

// ── Todo 状态流淌不变量：合法迁移表 + 最多一个 in_progress ──

const VALID_TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  // pending → completed 允许跳过 in_progress：一轮内批量收尾多条 todo 时
  // 不必逐条走 in_progress → completed（同一时刻最多一个 in_progress，
  // 严格线性会强迫模型一轮只能划掉一条）。
  pending: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

interface TodoValidationResult {
  items: TodoItem[];
  corrections: string[];
}

function validateAndCorrectTodos(
  newItems: TodoItem[],
  oldItems: TodoItem[],
): TodoValidationResult {
  const corrections: string[] = [];
  const result: TodoItem[] = [];
  const seenIds = new Set<string>();

  // 找出旧的状态映射
  const oldStatusMap = new Map<string, TodoStatus>();
  for (const item of oldItems) {
    oldStatusMap.set(item.id, item.status);
  }

  // 最多一个 in_progress
  let inProgressCount = 0;
  let firstInProgress = true;

  for (const item of newItems) {
    // id 唯一性
    if (seenIds.has(item.id)) {
      corrections.push(`ID "${item.id}" 重复，跳过后续重复项`);
      continue;
    }
    seenIds.add(item.id);

    // 状态合法性
    const validStatuses: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
    if (!validStatuses.includes(item.status)) {
      corrections.push(`ID "${item.id}" 状态 "${item.status}" 无效，降级为 pending`);
      result.push({ ...item, status: "pending" });
      continue;
    }

    // 状态转移合法性
    const oldStatus = oldStatusMap.get(item.id);
    if (oldStatus && oldStatus !== item.status) {
      const allowed = VALID_TRANSITIONS[oldStatus];
      if (!allowed.includes(item.status)) {
        corrections.push(
          `ID "${item.id}" 非法状态转移 ${oldStatus} → ${item.status}，保持原状态 ${oldStatus}`,
        );
        result.push({ ...item, status: oldStatus });
        continue;
      }
    }

    // 最多一个 in_progress
    if (item.status === "in_progress") {
      inProgressCount++;
      if (inProgressCount > 1) {
        corrections.push(
          `ID "${item.id}" 被降级为 pending（已有 in_progress 任务，最多一个）`,
        );
        result.push({ ...item, status: "pending" });
        firstInProgress = false;
        continue;
      }
    }

    result.push(item);
  }

  return { items: result, corrections };
}

/**
 * 执行 update_todo（模型自维护任务清单）。
 * 返回 ToolObservation，包含修正后的实际列表 + 修正说明。
 */
export async function executeUpdateTodo(
  call: ToolCall,
  state: AgentState,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const args = parseToolCallArgs(call);
  const rawTodos = (args.todos as unknown) ?? [];

  if (!Array.isArray(rawTodos)) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: UPDATE_TODO_TOOL_ID,
      message: "todos 参数必须是数组",
    };
  }

  const typedTodos: TodoItem[] = rawTodos.map((t: unknown) => {
    const item = t as Record<string, unknown>;
    return {
      id: String(item.id ?? ""),
      content: String(item.content ?? ""),
      status: (String(item.status ?? "pending") as TodoStatus),
      ...(item.activeForm ? { activeForm: String(item.activeForm) } : {}),
    };
  });

  const { items, corrections } = validateAndCorrectTodos(typedTodos, state.todoItems);

  // 更新 state
  state.todoItems = items;

  // 发事件给 UI
  onEvent?.({ type: "todo_update", items });

  // 构造返回（包含修正后的实际列表 + 修正说明）
  const correctionNote =
    corrections.length > 0
      ? `\n\n⚠️ Runtime 修正了以下违规：\n${corrections.map((c) => `- ${c}`).join("\n")}`
      : "\n\n✅ 所有 invariant 检查通过，列表已原样接受。";

  const todoSummary = items
    .map((t) => `  [${t.status}] ${t.id}: ${t.content}`)
    .join("\n");

  return {
    outcome: "success",
    tool: UPDATE_TODO_TOOL_ID,
    message: `待办列表已更新（${items.length} 项）：\n${todoSummary}${correctionNote}`,
    output: JSON.stringify({ items, corrections }),
  };
}

// ── ask_user ─────────────────────────────────────────────

export const ASK_USER_TOOL_ID = "ask_user";

export const askUserToolSpec: ToolSpec = {
  name: ASK_USER_TOOL_ID,
  description:
    "在执行过程中需要用户提供偏好、澄清歧义、选择方向或补充自由文本时调用。" +
    "这是排他工具：一轮里出现 ask_user 时，其他工具调用不执行。\n" +
    "一次可问 1-3 个问题；支持单选、多选和自由填写。每题都必须回答，用户也可以自由填写“停止”等明确意图。" +
    "不要用最终回复向用户提问；需要用户回答后继续当前任务时，应调用此工具。\n" +
    "向用户征求**偏好/确认**时用本工具；不要用于出题测试用户的学习掌握程度（那是 pop_quiz 的职责：pop_quiz 是你考用户，ask_user 是你问用户）。",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        description: "要问用户的问题列表",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "问题唯一标识" },
            question: { type: "string", description: "问题文本" },
            type: {
              type: "string",
              enum: ["single_select", "multi_select", "text"],
              description: "single_select=单选；multi_select=多选；text=自由填写",
            },
            options: {
              type: "array",
              description: "单选/多选的可选项列表；text 类型不要传入",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项显示文本" },
                  value: { type: "string", description: "选项值" },
                  description: { type: "string", description: "选项补充说明（可选）" },
                },
                required: ["label", "value"],
              },
            },
          },
          required: ["id", "question", "type"],
        },
      },
    },
    required: ["questions"],
  },
};

type HarnessAskQuestionType = "single_select" | "multi_select" | "text";

interface HarnessAskQuestion {
  id: string;
  question: string;
  type: HarnessAskQuestionType;
  options: Array<{ label: string; value: string; description?: string }>;
}

interface AskAnswer {
  questionId: string;
  selectedValues?: string[];
  selectedLabels?: string[];
  customInput?: string;
}

const ASK_OPTION_LIMITS: Record<HarnessAskQuestionType, { min: number; max: number }> = {
  single_select: { min: 2, max: 6 },
  multi_select: { min: 2, max: 8 },
  text: { min: 0, max: 0 },
};

function parseAskQuestions(raw: unknown): { questions?: HarnessAskQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) {
    return { error: "questions 必须是包含 1-3 个问题的数组" };
  }

  const ids = new Set<string>();
  const questions: HarnessAskQuestion[] = [];
  for (const [index, candidate] of raw.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { error: `第 ${index + 1} 个问题必须是对象` };
    }
    const item = candidate as Record<string, unknown>;
    const id = String(item.id ?? "").trim();
    const question = String(item.question ?? "").trim();
    const type = String(item.type ?? "");
    if (!id || ids.has(id)) return { error: `第 ${index + 1} 个问题的 id 必须非空且唯一` };
    if (!question) return { error: `第 ${index + 1} 个问题文本不能为空` };
    if (type !== "single_select" && type !== "multi_select" && type !== "text") {
      return { error: `第 ${index + 1} 个问题 type 必须是 single_select、multi_select 或 text` };
    }

    const rawOptions = item.options;
    if (rawOptions !== undefined && !Array.isArray(rawOptions)) {
      return { error: `第 ${index + 1} 个问题的 options 必须是数组` };
    }
    const optionsSource = (rawOptions ?? []) as unknown[];
    const limits = ASK_OPTION_LIMITS[type];
    if (optionsSource.length < limits.min || optionsSource.length > limits.max) {
      return { error: `第 ${index + 1} 个 ${type} 问题必须有 ${limits.min}-${limits.max} 个选项` };
    }

    const values = new Set<string>();
    const options: HarnessAskQuestion["options"] = [];
    for (const optionCandidate of optionsSource) {
      if (!optionCandidate || typeof optionCandidate !== "object" || Array.isArray(optionCandidate)) {
        return { error: `第 ${index + 1} 个问题含有无效选项` };
      }
      const option = optionCandidate as Record<string, unknown>;
      const label = String(option.label ?? "").trim();
      const value = String(option.value ?? "").trim();
      if (!label || !value || values.has(value)) {
        return { error: `第 ${index + 1} 个问题的选项 label/value 必须非空，且 value 不可重复` };
      }
      values.add(value);
      const description = typeof option.description === "string" ? option.description.trim() : "";
      options.push({ label, value, ...(description ? { description } : {}) });
    }

    ids.add(id);
    questions.push({ id, question, type, options });
  }
  return { questions };
}

/**
 * 把 ask_user 的回答格式化为工具卡可读的「问题 → 回答」预览行。
 * 失败/超时回退原始 message；未回答的问题标记为「未回答」。
 */
export function formatAskUserPreview(
  parsed: { questions?: HarnessAskQuestion[] },
  observation: ToolObservation,
): string[] | string {
  if (observation.outcome !== "success") return observation.message;
  let answers: AskAnswer[] = [];
  try {
    const output = JSON.parse(observation.output ?? "{}") as { answers?: AskAnswer[] };
    if (Array.isArray(output.answers)) answers = output.answers;
  } catch {
    // 输出不是合法 JSON 时按全部未回答处理
  }
  return (parsed.questions ?? []).map((question) => {
    const matched = answers.find((answer) => answer.questionId === question.id);
    const custom = matched?.customInput?.trim();
    const reply = custom || (matched?.selectedLabels ?? []).filter(Boolean).join("、");
    return `${question.question} → ${reply || "未回答"}`;
  });
}

/**
 * 执行 ask_user（交互式澄清提问，await 用户应答）。
 * 完全复用现有 requestUserClarification 链路。
 */
export async function executeAskUser(
  call: ToolCall,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const args = parseToolCallArgs(call);
  const rawQuestions = (args.questions as unknown) ?? [];

  const parsed = parseAskQuestions(rawQuestions);
  if (!parsed.questions) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: ASK_USER_TOOL_ID,
      message: parsed.error ?? "questions 参数无效",
    };
  }
  const questions = parsed.questions;

  if (!requestUserClarification) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: ASK_USER_TOOL_ID,
      message: "requestUserClarification 函数未注入，无法向用户提问",
    };
  }

  // 构造 AskClarificationCard（复用现有 UI 卡片格式）
  // 关键: AskClarificationCard.questions[].field 是 AskCard 内部 key;
  // AskUserAnswer.answers[].field 返回时就是这个 field.
  // 我们把 question.id 映射到 field, 收答案时再翻译回 questionId, 让模型无歧义看到.
  const card = {
    mode: "semantic_clarification" as const,
    intro: "任务需要补全信息",
    questions: questions.map((q) => ({
      field: q.id,                    // ← 用 field 承载 question.id
      question: q.question,
      type: q.type,
      options: q.options,
      allowCustom: true,
      freeTextPlaceholder: q.type === "text" ? "请输入回答" : "或填写其他回答",
    })),
    deferredFields: [],
  };

  onEvent?.({ type: "ask_user", card });

  try {
    const rawAnswer = await requestUserClarification(card);
    // AskUserAnswer.answers[] 的 field 就是上面我们塞进去的 question.id
    const rawAnswers = (rawAnswer as { answers?: Array<{ field?: string; selectedValues?: string[]; customText?: string }> })?.answers ?? [];

    // 超时签名：requestUserClarification 超时统一 resolve 空 answers；
    // 用户真实回答经校验后至少有一条。给模型明确的系统提示而非"校验失败"，
    // 由模型自行决策：等待用户补充，或信息足够时继续完成小任务。
    if (rawAnswers.length === 0) {
      return {
        outcome: "success",
        tool: ASK_USER_TOOL_ID,
        message: "系统提示：用户未在时限内回答问题。请停止等待用户补充；若现有信息已足够完成当前任务，可基于现有信息继续执行。",
      };
    }

    const answers: AskAnswer[] = [];
    for (const q of questions) {
      const matched = rawAnswers.find((a) => a.field === q.id);
      const customInput = matched?.customText?.trim();
      const selectedValues = Array.isArray(matched?.selectedValues) ? matched.selectedValues : [];
      const validSelectedValues = selectedValues.every((value) => q.options.some((option) => option.value === value));
      const expectedSelectionCount = q.type === "single_select" ? 1 : q.type === "multi_select" ? 1 : 0;
      if (!matched || (customInput && selectedValues.length > 0) || (!customInput && selectedValues.length < expectedSelectionCount)
        || !validSelectedValues || (q.type !== "multi_select" && selectedValues.length > expectedSelectionCount)) {
        return {
          outcome: "failure",
          category: "timeout",
          tool: ASK_USER_TOOL_ID,
          message: "未收到每个问题的有效回答，不能把空回答当作用户选择",
        };
      }
      if (customInput) {
        answers.push({ questionId: q.id, customInput });
        continue;
      }
      const selectedLabels = selectedValues.map((value) => q.options.find((option) => option.value === value)?.label ?? value);
      answers.push({ questionId: q.id, selectedValues, selectedLabels });
    }

    // 成功返回：把「问题 → 回答」逐条写进 message，工具卡点开即可看到具体问答
    const observation: ToolObservation = {
      outcome: "success",
      tool: ASK_USER_TOOL_ID,
      message: `用户已回答 ${answers.length} 个问题`,
      output: JSON.stringify({ answers }),
    };
    const preview = formatAskUserPreview({ questions }, observation);
    return {
      ...observation,
      message: Array.isArray(preview) ? `${observation.message}\n${preview.join("\n")}` : observation.message,
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return {
      outcome: "failure",
      category: "timeout",
      tool: ASK_USER_TOOL_ID,
      message: `用户回答超时或失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── confirm_uncertain_effect ─────────────────────────────

export const CONFIRM_UNCERTAIN_EFFECT_TOOL_ID = "confirm_uncertain_effect";

export const confirmUncertainEffectToolSpec: ToolSpec = {
  name: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  description:
    "当 Runtime 报告 unresolved uncertain effect 时，使用 effectId 请求用户明确确认是否允许再执行一次。" +
    "确认文案和选项由 Runtime 固定生成，不能由模型提供。该工具与 ask_user 一样是排他工具。",
  parameters: {
    type: "object",
    properties: {
      effectId: { type: "string", description: "Runtime observation 给出的 effectId" },
    },
    required: ["effectId"],
  },
};

export async function executeConfirmUncertainEffect(
  call: ToolCall,
  state: AgentState,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
): Promise<ToolObservation> {
  const effectId = String(parseToolCallArgs(call).effectId ?? "").trim();
  const effect = state.uncertainEffects.find((candidate) => candidate.id === effectId);
  if (!effect) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: `未找到 unresolved uncertain effect: ${effectId || "(empty)"}`,
    };
  }
  if (!requestUserClarification) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: "requestUserClarification 函数未注入，无法取得用户确认",
    };
  }

  const card = {
    mode: "semantic_clarification" as const,
    intro: `前一次 ${effect.toolName} 的结果无法确认。再次执行可能产生重复副作用。`,
    questions: [{
      field: "decision",
      question: "是否仍要允许下一次相同操作？",
      type: "single_select" as const,
      options: [
        { value: "allow_repeat", label: "仍然允许一次" },
        { value: "do_not_repeat", label: "不要重复执行" },
      ],
      allowCustom: false,
      freeTextPlaceholder: "",
    }],
    deferredFields: [],
  };

  try {
    const raw = await requestUserClarification(card) as {
      answers?: Array<{ field?: string; selectedValues?: string[] }>;
    };
    const decision = raw.answers?.find((answer) => answer.field === "decision")?.selectedValues?.[0];
    const matchedEffect = state.uncertainEffects.find((effect) => effect.id === effectId);
    const authorized = decision === "allow_repeat" && Boolean(matchedEffect);
    if (authorized && matchedEffect) {
      resolveUncertainEffect(state, matchedEffect.toolCallId);
    }
    return {
      outcome: "success",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: authorized
        ? "用户已明确授权下一次匹配操作；授权只消费一次。"
        : "用户未授权重复操作；uncertain effect 保持 unresolved。",
      output: JSON.stringify({ effectId, authorized }),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      outcome: "failure",
      category: "timeout",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: `用户确认超时或失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── 内置工具注册 ─────────────────────────────────────────

export const HARNESS_BUILTIN_TOOL_IDS = new Set([
  TASK_TOOL_ID,
  UPDATE_TODO_TOOL_ID,
  ASK_USER_TOOL_ID,
  CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  READ_TOOL_RESULT_TOOL_ID,
  ENTER_PLAN_MODE_TOOL_ID,
  WRITE_PLAN_TOOL_ID,
]);

export function isHarnessBuiltin(toolName: string): boolean {
  return HARNESS_BUILTIN_TOOL_IDS.has(toolName);
}

export function isInteractiveHarnessBuiltin(toolName: string): boolean {
  return toolName === ASK_USER_TOOL_ID || toolName === CONFIRM_UNCERTAIN_EFFECT_TOOL_ID;
}

/**
 * 计划工具组按状态注入（可见性即防御）：
 * - NORMAL：enter_plan_mode + write_plan。工具列表是 run 级固定的，模型常在
 *   同一 run 内先调 enter_plan_mode 再调 write_plan，因此两者必须同时注入；
 *   write_plan 自身有状态守卫（非 PLAN_DISCUSSING 调用直接 failure）。
 * - PLAN_DISCUSSING：仅 write_plan（enter_plan_mode 物理隐藏，幂等防御）
 * - PLAN_REVIEW / EXECUTING：全部隐藏（REVIEW 无模型轮；EXECUTING 防执行中再进计划）
 * - undefined（旧调用方/子任务）：不注入任何计划工具
 */
function planToolSpecsFor(planState: import("../plan-mode").PlanStateName | undefined): ToolSpec[] {
  switch (planState) {
    case "NORMAL":
      return [enterPlanModeToolSpec, writePlanToolSpec];
    case "PLAN_DISCUSSING":
      return [writePlanToolSpec];
    default:
      return [];
  }
}

export function getHarnessBuiltinToolSpecs(options?: {
  includeInteractive?: boolean;
  includeTask?: boolean;
  planState?: import("../plan-mode").PlanStateName;
}): ToolSpec[] {
  const interactive = options?.includeInteractive !== false
    ? [askUserToolSpec, confirmUncertainEffectToolSpec]
    : [];
  const task = options?.includeTask === false ? [] : [taskToolSpec];
  const plan = planToolSpecsFor(options?.planState);
  return [updateTodoToolSpec, ...interactive, ...task, readToolResultToolSpec, ...plan];
}
