import { t } from "../../../i18n";
import type { AskCardSubmission } from "../../../../../shared/ask-clarification";

export type AgentRunStageKind =
  | "understanding"
  | "planning"
  | "executing"
  | "waiting_permission"
  | "waiting_user"
  | "responding"
  | "completed"
  | "cancelled"
  | "timeout"
  | "failed";

export interface AgentRunStage {
  kind: AgentRunStageKind;
  detail?: string;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  status?: "pending" | "running" | "completed" | "failed";
}

export interface TaskPlanPresentation {
  title?: string;
  steps: TaskPlanStep[];
}

export interface AskUserInteraction {
  kind: "ask";
  id: string;
  source?: "agent";
  runId?: string;
  revision?: number;
  intro?: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  allowCustomInput?: boolean;
  /** Structured clarification cards advance through these questions in the same bottom slot. */
  questions?: AskUserQuestion[];
  responseKind?: "choice" | "clarification" | "submission";
  currentQuestion?: number;
  totalQuestions?: number;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  allowCustomInput?: boolean;
  freeTextPlaceholder?: string;
  multiple?: boolean;
}

export interface AskQuestionDraft {
  source: "option" | "custom" | null;
  optionIds: string[];
  customText: string;
}

export type AskDrafts = Record<string, AskQuestionDraft>;

export interface PermissionInteraction {
  kind: "permission";
  id: string;
  source?: "agent";
  sessionId?: string;
  toolName: string;
  summary: string;
  workspaceName?: string;
  targetPath?: string;
}

export interface PopQuizInteraction {
  kind: "quiz";
  /** quizId，同时是提交与结算广播的幂等键。 */
  id: string;
  runId?: string;
  intro: string;
  questions: Array<{
    id: string;
    type: "choice" | "multi" | "true_false" | "short_answer";
    question: string;
    options: Array<{ id: string; label: string }>;
    learningObjective: string;
  }>;
}

export interface PermissionRequestDescription {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type ComposerInteraction = AskUserInteraction | PermissionInteraction | PopQuizInteraction;

export type ComposerSlotKind = "composer" | ComposerInteraction["kind"];

export function resolveComposerSlot(interaction?: ComposerInteraction): ComposerSlotKind {
  return interaction?.kind ?? "composer";
}

/**
 * 从 RUN_FINISHED 事件 result 字段解析终态 stage。
 * - success → completed
 * - cancelled → cancelled（保留已有部分输出，不生成"任务已完成"）
 * - timeout → timeout（不伪装成功）
 * - runtime_error → failed（防御性；正常走 RUN_ERROR 路径）
 * - 缺失 result.status → completed（向后兼容旧 upstream）
 */
export function resolveRunFinishedStage(
  result: { status?: string } | undefined | null,
): AgentRunStage {
  const status = result?.status;
  switch (status) {
    case "success":
      return { kind: "completed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "timeout":
      return { kind: "timeout" };
    case "runtime_error":
      return { kind: "failed" };
    default:
      return { kind: "completed" };
  }
}

/**
 * 根据终态 status 决定显示内容。
 * - success：有内容用内容，空则用"任务已完成。"兜底
 * - cancelled：保留已有部分输出，空则返回空串（绝不生成"任务已完成。"）
 * - timeout：同 cancelled
 * - runtime_error / 未知：保留已有内容
 */
export function resolveTerminalContent(
  streamContent: string,
  status: string | undefined,
): string {
  const trimmed = streamContent.trim();
  switch (status) {
    case "success":
      return trimmed;
    case "cancelled":
    case "timeout":
      // 保留已有部分输出；空或纯空白则返回空串（绝不生成"任务已完成。"）
      return trimmed;
    default:
      return streamContent;
  }
}

export function isFormalAnswerCommitted(
  content: string,
  status: string | undefined,
  finalMessageCompleted: boolean,
): boolean {
  return status === "success" && finalMessageCompleted && content.trim().length > 0;
}

/** A stale terminal from an older run must not dismiss the current run's card. */
export function shouldClearComposerInteractionForTerminal(
  activeRunId: string | undefined,
  terminalRunId: string | undefined,
): boolean {
  return !activeRunId || !terminalRunId || activeRunId === terminalRunId;
}

function readPermissionString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function shortenPermissionText(value: string, maxLength = 48): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** Converts a runtime permission request into the concise action the user approves. */
export function describePermissionRequest(request: PermissionRequestDescription): string {
  switch (request.toolId) {
    case "weather": {
      const city = readPermissionString(request.args, ["city"]);
      return city ? t("runPresentation.permissionWeather", { city: shortenPermissionText(city, 24) }) : t("runPresentation.permissionWeatherPlain");
    }
    case "web_search": {
      const query = readPermissionString(request.args, ["query", "keyword"]);
      return query ? t("runPresentation.permissionSearch", { query: shortenPermissionText(query) }) : t("runPresentation.permissionSearchPlain");
    }
    case "write_word": {
      const filename = readPermissionString(request.args, ["filename"]);
      return filename ? t("runPresentation.permissionWord", { filename: shortenPermissionText(filename) }) : t("runPresentation.permissionWordPlain");
    }
    case "write_excel": {
      const filename = readPermissionString(request.args, ["filename"]);
      return filename ? t("runPresentation.permissionExcel", { filename: shortenPermissionText(filename) }) : t("runPresentation.permissionExcelPlain");
    }
    case "write_powerpoint": {
      const filename = readPermissionString(request.args, ["filename"]);
      return filename ? t("runPresentation.permissionPowerpoint", { filename: shortenPermissionText(filename) }) : t("runPresentation.permissionPowerpointPlain");
    }
    default:
      return t("runPresentation.permissionFallback", { toolName: request.toolName || request.toolId });
  }
}

export function describeRunStage(stage: AgentRunStage): string {
  switch (stage.kind) {
    case "understanding":
      return t("runPresentation.stageUnderstanding");
    case "planning":
      return t("runPresentation.stagePlanning");
    case "executing":
      return stage.detail
        ? t("runPresentation.stageExecutingDetail", { detail: stage.detail })
        : t("runPresentation.stageExecuting");
    case "waiting_permission":
      return t("runPresentation.stageWaitingPermission");
    case "waiting_user":
      return t("runPresentation.stageWaitingUser");
    case "responding":
      return t("runPresentation.stageResponding");
    case "completed":
      return t("runPresentation.stageCompleted");
    case "cancelled":
      return t("runPresentation.stageCancelled");
    case "timeout":
      return t("runPresentation.stageTimeout");
    case "failed":
      return t("runPresentation.stageFailed");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 抽查题型白名单校验：合法值收敛为字面量联合（string 的负向 !== 检查不产生收窄） */
function asPopQuizQuestionType(
  value: unknown,
): PopQuizInteraction["questions"][number]["type"] | undefined {
  return value === "choice" || value === "multi" || value === "true_false" || value === "short_answer"
    ? value
    : undefined;
}

function normalizeOptions(value: unknown): AskUserQuestion["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = asRecord(item);
    const id = asNonEmptyString(option?.value);
    const label = asNonEmptyString(option?.label);
    if (!id || !label) return [];
    return [{ id, label, description: asNonEmptyString(option?.description) }];
  });
}

function normalizePublicOptions(value: unknown): AskUserQuestion["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = asRecord(item);
    const id = asNonEmptyString(option?.id);
    const label = asNonEmptyString(option?.label);
    if (!id || !label) return [];
    return [{ id, label, description: asNonEmptyString(option?.description) }];
  });
}

/**
 * Accepts the two card payloads already emitted by main. Keeping this at the
 * renderer boundary makes malformed CUSTOM events inert instead of interactive.
 */
export function normalizeChoiceInteraction(value: unknown): AskUserInteraction | undefined {
  const card = asRecord(value);
  if (!card) return undefined;
  const interactionId = asNonEmptyString(card?.interactionId);
  const runId = asNonEmptyString(card?.runId);
  const revision = typeof card?.revision === "number" && Number.isInteger(card.revision)
    ? card.revision
    : undefined;
  if (interactionId && runId && revision !== undefined && Array.isArray(card.questions)) {
    const questions = card.questions.flatMap((item) => {
      const question = asRecord(item);
      if (!question) return [];
      const customInput = asRecord(question?.customInput);
      const id = asNonEmptyString(question?.id);
      const prompt = asNonEmptyString(question?.prompt);
      const options = normalizePublicOptions(question?.options);
      const isTextQuestion = options.length === 0;
      if (!id || !prompt || typeof customInput?.enabled !== "boolean") return [];
      if (!isTextQuestion && options.length < 2) return [];
      if (isTextQuestion && customInput.enabled !== true) return [];
      return [{
        id,
        question: prompt,
        options,
        allowCustomInput: customInput.enabled,
        freeTextPlaceholder: asNonEmptyString(customInput.placeholder),
        multiple: question.multiple === true,
      } satisfies AskUserQuestion];
    });
    if (questions.length !== card.questions.length || questions.length === 0) return undefined;
    return {
      kind: "ask",
      id: interactionId,
      runId,
      revision,
      intro: asNonEmptyString(card.intro),
      responseKind: "submission",
      question: questions[0].question,
      options: questions[0].options,
      questions,
    };
  }

  const id = asNonEmptyString(card?.id);
  if (!id) return undefined;

  const structuredQuestions = Array.isArray(card.questions) ? card.questions.flatMap((item) => {
    const question = asRecord(item);
    if (!question) return [];
    const field = asNonEmptyString(question?.field);
    const text = asNonEmptyString(question?.question);
    if (!field || !text) return [];
    return [{
      id: field,
      question: text,
      options: normalizeOptions(question.options),
      allowCustomInput: question.allowCustom !== false,
      freeTextPlaceholder: asNonEmptyString(question.freeTextPlaceholder),
      multiple: question.type === "multi_select",
    } satisfies AskUserQuestion];
  }) : [];
  if (structuredQuestions.length > 0) {
    const first = structuredQuestions[0];
    return {
      kind: "ask",
      id,
      question: first.question,
      options: first.options,
      questions: structuredQuestions,
      responseKind: "clarification",
    };
  }

  const question = asNonEmptyString(card.question);
  const options = normalizeOptions(card.options);
  if (!question || options.length === 0) return undefined;
  return {
    kind: "ask",
    id,
    question,
    options,
    allowCustomInput: true,
    responseKind: "choice",
  };
}

/** Routes a post-run plan approval card only to the conversation that owns it. */
export function normalizeDeferredPlanChoice(
  value: unknown,
  activeSessionId: string,
): AskUserInteraction | undefined {
  const card = asRecord(value);
  if (asNonEmptyString(card?.sessionId) !== activeSessionId) return undefined;
  return normalizeChoiceInteraction(value);
}

/**
 * 边界校验主进程推来的抽查卡片。畸形 payload 直接判失效（不渲染），
 * 与 ask 卡片同款防线；主进程 10s 幂等重播，短暂畸形不会卡住用户。
 */
export function normalizePopQuizCard(value: unknown): PopQuizInteraction | undefined {
  const card = asRecord(value);
  if (!card) return undefined;
  const quizId = asNonEmptyString(card?.quizId);
  const runId = asNonEmptyString(card?.runId);
  if (!quizId || !runId || !Array.isArray(card.questions)) return undefined;
  const questions = (card.questions as unknown[]).flatMap((item) => {
    const question = asRecord(item);
    if (!question) return [];
    const id = asNonEmptyString(question?.id);
    const type = asPopQuizQuestionType(question?.type);
    const prompt = asNonEmptyString(question?.question);
    if (!id || !prompt || !type) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const record = asRecord(option);
          const optionId = asNonEmptyString(record?.id);
          const label = asNonEmptyString(record?.label);
          return optionId && label ? [{ id: optionId, label }] : [];
        })
      : [];
    // 选择题没选项就没法答；判断题/简答题本来就不带选项
    if ((type === "choice" || type === "multi") && options.length < 2) return [];
    return [{
      id,
      type,
      question: prompt,
      options,
      learningObjective: asNonEmptyString(question.learningObjective) ?? "",
    }];
  });
  // 题目数量或内容对不上主进程的发布（1-3 题）时整卡废弃，避免渲染半张残卡
  if (questions.length === 0 || questions.length !== card.questions.length) return undefined;
  return {
    kind: "quiz",
    id: quizId,
    runId,
    intro: asNonEmptyString(card.intro) ?? "",
    questions,
  };
}

export function createAskDrafts(questions: AskUserQuestion[]): AskDrafts {
  return Object.fromEntries(questions.map((question) => [question.id, {
    source: null,
    optionIds: [],
    customText: "",
  } satisfies AskQuestionDraft]));
}

export function selectAskOption(
  drafts: AskDrafts,
  question: AskUserQuestion,
  optionId: string,
): AskDrafts {
  if (!question.options.some((option) => option.id === optionId)) return drafts;
  const current = drafts[question.id] ?? { source: null, optionIds: [], customText: "" };
  const optionIds = question.multiple
    ? (current.optionIds.includes(optionId)
        ? current.optionIds.filter((id) => id !== optionId)
        : [...current.optionIds, optionId])
    : [optionId];
  return {
    ...drafts,
    [question.id]: {
      source: optionIds.length > 0 ? "option" : null,
      optionIds,
      customText: "",
    },
  };
}

export function updateAskCustomText(drafts: AskDrafts, questionId: string, text: string): AskDrafts {
  return {
    ...drafts,
    [questionId]: {
      source: text.trim() ? "custom" : null,
      optionIds: [],
      customText: text,
    },
  };
}

export function isAskComplete(questions: AskUserQuestion[], drafts: AskDrafts): boolean {
  return questions.every((question) => {
    const draft = drafts[question.id];
    return draft?.source === "option" && draft.optionIds.length > 0
      || draft?.source === "custom" && Boolean(draft.customText.trim());
  });
}

export function buildAskSubmission(
  interaction: AskUserInteraction,
  drafts: AskDrafts,
): AskCardSubmission {
  const questions = interaction.questions ?? [];
  if (interaction.responseKind !== "submission"
    || !interaction.runId
    || interaction.revision === undefined
    || !isAskComplete(questions, drafts)) {
    throw new Error("E_ASK_SUBMISSION_INCOMPLETE");
  }
  return {
    interactionId: interaction.id,
    runId: interaction.runId,
    revision: interaction.revision,
    answers: questions.map((question) => {
      const draft = drafts[question.id];
      if (draft.source === "custom") {
        return { questionId: question.id, source: "custom" as const, text: draft.customText.trim() };
      }
      return question.multiple
        ? { questionId: question.id, source: "option" as const, optionIds: draft.optionIds }
        : { questionId: question.id, source: "option" as const, optionId: draft.optionIds[0] };
    }),
  };
}

export function shouldDismissAsk(interaction: AskUserInteraction, value: unknown): boolean {
  const settlement = asRecord(value);
  if (asNonEmptyString(settlement?.id) !== interaction.id) return false;
  if (!interaction.runId || interaction.revision === undefined) return true;
  return asNonEmptyString(settlement?.runId) === interaction.runId
    && settlement?.revision === interaction.revision;
}

/** Converts the existing LangGraph CUSTOM payload into the small UI-only plan shape. */
export function normalizeTaskPlanPresentation(value: unknown): TaskPlanPresentation | undefined {
  const snapshot = asRecord(value);
  const steps = Array.isArray(snapshot?.steps) ? snapshot.steps.flatMap((item) => {
    const step = asRecord(item);
    if (!step) return [];
    const id = asNonEmptyString(step?.stepId);
    const title = asNonEmptyString(step?.objective);
    if (!id || !title) return [];
    const sourceStatus = asNonEmptyString(step.status);
    const status: TaskPlanStep["status"] = sourceStatus === "running"
      ? "running"
      : sourceStatus === "completed"
        ? "completed"
        : sourceStatus === "failed"
          ? "failed"
          : "pending";
    return [{ id, title, status }];
  }) : [];
  if (steps.length === 0) return undefined;
  return { title: asNonEmptyString(snapshot?.goal), steps };
}
