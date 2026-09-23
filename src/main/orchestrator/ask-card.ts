import type {
  AskCardPayload,
  AskCardSubmission,
  AskClarificationCard,
  AskClarificationOutput,
  AskUserAnswer,
} from "../../shared/ask-clarification";

const CUSTOM_OPTION = {
  value: "__custom__",
  label: "其他，我自己填写",
} as const;

export function buildAskCard(
  output: AskClarificationOutput,
  mode: AskClarificationCard["mode"] = "semantic_clarification",
): AskClarificationCard {
  return {
    mode,
    intro: output.intro,
    questions: output.questions.slice(0, 3).map((question) => {
      const options = question.options
        .filter((option) => option.value !== CUSTOM_OPTION.value)
        .slice(0, 3);
      if (question.type !== "text" && options.length < 2) throw new Error("E_ASK_OPTIONS_INSUFFICIENT");
      return {
        ...question,
        options,
        allowCustom: question.allowCustom,
      };
    }),
    deferredFields: output.deferredFields,
  };
}

function invalidAnswer(): never {
  throw new Error("E_ASK_ANSWER_INVALID");
}

interface PublishedQuestion {
  field: string;
  type: AskClarificationCard["questions"][number]["type"];
  options: Map<string, string>;
  allowCustom: boolean;
}

/** Main-process-only publication state. Never send this object to Renderer. */
export interface AskCardPublication {
  payload: AskCardPayload;
  privateQuestions: Map<string, PublishedQuestion>;
}

export function publishAskCard(
  card: AskClarificationCard,
  identity: Pick<AskCardPayload, "interactionId" | "runId" | "revision">,
): AskCardPublication {
  const privateQuestions = new Map<string, PublishedQuestion>();
  const questions = card.questions.map((question, questionIndex) => {
    const questionId = `question-${questionIndex + 1}`;
    const canonicalOptions = question.options.filter((option) => option.value !== CUSTOM_OPTION.value);
    const options = new Map<string, string>();
    const publicOptions = canonicalOptions.map((option, optionIndex) => {
      const id = `${questionId}-option-${optionIndex + 1}`;
      options.set(id, option.value);
      return {
        id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      };
    });
    const allowCustom = question.type === "text" || question.allowCustom;
    privateQuestions.set(questionId, {
      field: question.field,
      type: question.type,
      options,
      allowCustom,
    });
    return {
      id: questionId,
      prompt: question.question,
      multiple: question.type === "multi_select",
      required: true as const,
      options: publicOptions,
      customInput: {
        enabled: allowCustom,
        ...(question.freeTextPlaceholder ? { placeholder: question.freeTextPlaceholder } : {}),
      },
    };
  });
  return {
    payload: {
      ...identity,
      mode: card.mode ?? "semantic_clarification",
      intro: card.intro,
      questions,
    },
    privateQuestions,
  };
}

export function resolveAskCardSubmission(
  publication: AskCardPublication,
  submission: AskCardSubmission,
): AskUserAnswer {
  const payload = publication.payload;
  if (submission.interactionId !== payload.interactionId
    || submission.runId !== payload.runId
    || submission.revision !== payload.revision
    || !Array.isArray(submission.answers)
    || submission.answers.length !== payload.questions.length) invalidAnswer();

  const seen = new Set<string>();
  const answers = submission.answers.map((answer) => {
    if (!answer || seen.has(answer.questionId)) invalidAnswer();
    seen.add(answer.questionId);
    const question = publication.privateQuestions.get(answer.questionId);
    if (!question) invalidAnswer();
    if (answer.source === "custom") {
      if ("optionId" in answer || "optionIds" in answer) invalidAnswer();
      const customText = answer.text?.trim();
      if (!question.allowCustom || !customText) invalidAnswer();
      return { field: question.field, customText };
    }
    // 计划审批"需要修改"：档位与意见同卡回传——选项按选项规则校验，意见按自定义输入规则校验
    if (answer.source === "option_with_text") {
      const customText = answer.text?.trim();
      const optionIds = answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
      if (!question.allowCustom || !customText || optionIds.length === 0
        || (!question.type.startsWith("multi") && optionIds.length !== 1)) invalidAnswer();
      const values = optionIds.map((optionId) => question.options.get(optionId));
      if (values.some((value) => value === undefined)) invalidAnswer();
      return {
        field: question.field,
        selectedValues: values as string[],
        customText,
      };
    }
    if (answer.source !== "option" || "text" in answer) invalidAnswer();
    const optionIds = answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
    if (optionIds.length === 0 || (!question.type.startsWith("multi") && optionIds.length !== 1)) invalidAnswer();
    const values = optionIds.map((optionId) => question.options.get(optionId));
    if (values.some((value) => value === undefined)) invalidAnswer();
    const canonicalValues = values as string[];
    return question.type === "text"
      ? { field: question.field, customText: canonicalValues[0] }
      : { field: question.field, selectedValues: canonicalValues };
  });
  return { requestId: payload.interactionId, answers };
}

export function validateAskUserAnswer(
  card: AskClarificationCard,
  requestId: string,
  answer: AskUserAnswer,
): AskUserAnswer {
  if (!answer || !Array.isArray(answer.answers)) invalidAnswer();
  const questions = new Map(card.questions.map((question) => [question.field, question]));
  const seen = new Set<string>();
  const answers = answer.answers.map((item) => {
    if (!item || typeof item.field !== "string" || seen.has(item.field)) invalidAnswer();
    const question = questions.get(item.field);
    if (!question) invalidAnswer();
    seen.add(item.field);
    const customText = item.customText?.trim();
    const selectedValues = item.selectedValues?.filter((value) => value !== "__custom__");
    if (question.type === "text") {
      if (!question.allowCustom || !customText) invalidAnswer();
      return { field: item.field, customText };
    }
    const allowed = new Set(question.options
      .filter((option) => option.value !== "__custom__")
      .map((option) => option.value));
    if (selectedValues?.some((value) => !allowed.has(value))) invalidAnswer();
    if (question.type === "single_select" && (selectedValues?.length ?? 0) > 1) invalidAnswer();
    if (customText && !question.allowCustom) invalidAnswer();
    if ((!selectedValues || selectedValues.length === 0) && !customText) invalidAnswer();
    return {
      field: item.field,
      ...(selectedValues?.length ? { selectedValues } : {}),
      ...(customText ? { customText } : {}),
    };
  });
  if (answers.length !== card.questions.length) invalidAnswer();
  return { requestId, answers };
}
