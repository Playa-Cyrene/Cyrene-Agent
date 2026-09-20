import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import {
  buildAskSubmission,
  createAskDrafts,
  isAskComplete,
  selectAskOption,
  updateAskCustomText,
  type AskUserInteraction,
  type AskUserQuestion,
  type PermissionInteraction,
  type PopQuizInteraction,
} from "./run-presentation";
import type {
  PopQuizGradedQuestion,
  PopQuizSubmission,
} from "../../../../../shared/pop-quiz";
import { MarkdownContent } from "./ChatMessageList";
import "./RunExperience.css";
import moodWarmUrl from "../../../assets/status-moods/温柔.png?url";
import moodCompanyUrl from "../../../assets/status-moods/陪伴中.png?url";
import moodSpoiledUrl from "../../../assets/status-moods/撒娇.png?url";
import moodLearnUrl from "../../../assets/status-moods/学习.png?url";

function PanelShell({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="cy-interaction-panel" aria-label={title}>
      {children}
    </section>
  );
}

export function AskUserPanel({
  interaction,
  disabled = false,
  onAnswer,
}: {
  interaction: AskUserInteraction;
  disabled?: boolean;
  onAnswer?: (answer: unknown) => void;
  onIgnore?: () => void;
}) {
  const { t } = useTranslation();
  const questions: AskUserQuestion[] = interaction.questions ?? [{
    id: "choice",
    question: interaction.question,
    options: interaction.options,
    allowCustomInput: interaction.allowCustomInput,
  }];
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState(() => createAskDrafts(questions));
  useEffect(() => {
    setPage(0);
    setDrafts(createAskDrafts(questions));
  }, [interaction.id]);
  const current = questions[Math.min(page, questions.length - 1)];
  const currentDraft = drafts[current.id] ?? { source: null, optionIds: [], customText: "" };
  const canSubmit = isAskComplete(questions, drafts);
  const submit = () => {
    if (!canSubmit) return;
    if (interaction.responseKind === "submission") {
      onAnswer?.(buildAskSubmission(interaction, drafts));
      return;
    }
    if (interaction.responseKind === "clarification") {
      onAnswer?.({
        requestId: interaction.id,
        answers: questions.map((question) => {
          const draft = drafts[question.id];
          return draft.source === "custom"
            ? { field: question.id, customText: draft.customText.trim() }
            : { field: question.id, selectedValues: draft.optionIds };
        }),
      });
      return;
    }
    onAnswer?.(currentDraft.source === "custom" ? currentDraft.customText.trim() : currentDraft.optionIds[0]);
  };

  return (
    <PanelShell title={t("interaction.askingTitle")}>
      <img src={moodWarmUrl} className="cy-interaction-panel__mood-bottom-left" alt="" />
      <div className="cy-interaction-panel__heading">
        <span className="cy-interaction-panel__status"><img src={moodCompanyUrl} alt="" />{t("interaction.askingTitle")}</span>
        {questions.length > 1 && (
          <nav className="cy-interaction-panel__pager" aria-label={t("interaction.pagerAria")}>
            <button type="button" aria-label={t("interaction.prevQuestion")} disabled={disabled || page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>‹</button>
            <span className="cy-interaction-panel__page">{page + 1} / {questions.length}</span>
            <button type="button" aria-label={t("interaction.nextQuestion")} disabled={disabled || page === questions.length - 1} onClick={() => setPage((value) => Math.min(questions.length - 1, value + 1))}>›</button>
          </nav>
        )}
      </div>
      {interaction.intro && (
        <div className="cy-interaction-panel__intro">
          <MarkdownContent content={interaction.intro} />
        </div>
      )}
      <div className="cy-interaction-panel__question">
        <MarkdownContent content={current.question} />
      </div>
      {current.options.length > 0 && (
        <div className="cy-interaction-panel__options" role={current.multiple ? "group" : "radiogroup"} aria-label={current.question}>
          {current.options.map((option, index) => (
            <button
              type="button"
              key={option.id}
              className={currentDraft.optionIds.includes(option.id) ? "is-selected" : ""}
              role={current.multiple ? "checkbox" : "radio"}
              aria-checked={currentDraft.optionIds.includes(option.id)}
              disabled={disabled}
              onClick={() => {
                setDrafts((values) => selectAskOption(values, current, option.id));
              }}
            >
              <span className="cy-interaction-panel__option-index">{index + 1}.</span>
              <div className="cy-interaction-panel__option-body">
                <MarkdownContent content={option.label} />
                {option.description && <small>{option.description}</small>}
              </div>
            </button>
          ))}
        </div>
      )}
      {current.allowCustomInput !== false && (
        <label className="cy-interaction-panel__custom-answer">
          <span>{t("interaction.customAnswerLabel")}</span>
          <input
            value={currentDraft.customText}
            disabled={disabled}
            placeholder={current.freeTextPlaceholder ?? t("interaction.customAnswerPlaceholder")}
            onChange={(event) => setDrafts((values) => updateAskCustomText(values, current.id, event.target.value))}
          />
        </label>
      )}
      {questions.length > 1 && (
        <div className="cy-interaction-panel__question-index" aria-label={t("interaction.questionProgressAria")}>
          {questions.map((question, index) => {
            const draft = drafts[question.id];
            const answered = draft?.source === "option" || draft?.source === "custom";
            return <button type="button" key={question.id} className={page === index ? "is-current" : ""} disabled={disabled} onClick={() => setPage(index)}>{answered ? "✓" : "○"} {index + 1}</button>;
          })}
        </div>
      )}
      <div className="cy-interaction-panel__actions">
        <button type="button" className="is-primary" disabled={disabled || !canSubmit} onClick={submit}>{questions.length > 1 ? t("interaction.submitAll") : t("interaction.submit")}</button>
      </div>
    </PanelShell>
  );
}

export function PermissionPanel({
  interaction,
  disabled = false,
  onDecision,
}: {
  interaction: PermissionInteraction;
  disabled?: boolean;
  onDecision?: (allowed: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <PanelShell title={t("interaction.permissionTitle")}>
      <img src={moodWarmUrl} className="cy-interaction-panel__mood-bottom-left" alt="" />
      <div className="cy-interaction-panel__heading">
        <span className="cy-interaction-panel__status"><img src={moodSpoiledUrl} alt="" />{t("interaction.permissionTitle")}</span>
      </div>
      <p className="cy-interaction-panel__question">{interaction.summary}</p>
      <dl className="cy-interaction-panel__metadata">
        {interaction.workspaceName && <><dt>{t("interaction.workspaceLabel")}</dt><dd>{interaction.workspaceName}</dd></>}
        {interaction.targetPath && <><dt>{t("interaction.targetLabel")}</dt><dd title={interaction.targetPath}>{interaction.targetPath}</dd></>}
      </dl>
      <div className="cy-interaction-panel__actions">
        <button type="button" disabled={disabled} onClick={() => onDecision?.(false)}>{t("interaction.deny")}</button>
        <button type="button" className="is-primary" disabled={disabled} onClick={() => onDecision?.(true)}>{t("interaction.allow")}</button>
      </div>
    </PanelShell>
  );
}

// ── pop_quiz 抽查卡片 ─────────────────────────────────────

/** 每题作答草稿：按题型只填对应字段，提交时原样组装。 */
type QuizDraft = {
  /** choice：选中的选项 id。 */
  optionId?: string;
  /** multi：选中的选项 id 列表。 */
  optionIds?: string[];
  /** true_false：true / false。 */
  boolean?: boolean;
  /** short_answer：用户原文。 */
  text?: string;
};

type QuizDrafts = Record<string, QuizDraft>;

/** 该题是否已作答（按题型检查对应字段）。 */
function isQuizQuestionAnswered(
  question: PopQuizInteraction["questions"][number],
  draft: QuizDraft | undefined,
): boolean {
  switch (question.type) {
    case "choice":
      return Boolean(draft?.optionId);
    case "multi":
      return (draft?.optionIds?.length ?? 0) > 0;
    case "true_false":
      return typeof draft?.boolean === "boolean";
    case "short_answer":
      return Boolean(draft?.text?.trim());
  }
}

/** 把作答下标（choice/multi）翻译回选项文字，供展示态呈现"你的回答/正确答案"。 */
function describeQuizAnswerValue(
  question: PopQuizInteraction["questions"][number],
  value: string | number | number[] | boolean | undefined,
  labels: { true: string; false: string },
): string {
  if (value === undefined) return "—";
  if (question.type === "choice" || question.type === "multi") {
    const indexes = Array.isArray(value) ? value : [value as number];
    return indexes
      .map((index) => question.options[index]?.label ?? String(index))
      .join("、");
  }
  if (question.type === "true_false") return value === true ? labels.true : labels.false;
  return String(value);
}

/**
 * 抽查卡片：作答态（分页答题 + 提交/跳过）→ 展示态（判分结果 + 解析）。
 * 提交后卡片不消失，切展示态等 Cyrene 拿到结果讲评；run 结束时统一清卡。
 */
export function PopQuizPanel({
  interaction,
  disabled = false,
  onSubmit,
  onSkip,
}: {
  interaction: PopQuizInteraction;
  disabled?: boolean;
  /** 提交作答：主进程本地判分，返回 graded 后切展示态。 */
  onSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: PopQuizGradedQuestion[] }>;
  /** 跳过整次抽查：主进程结算 skipped 后由广播清卡。 */
  onSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { t } = useTranslation();
  const questions = interaction.questions;
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<QuizDrafts>({});
  // submitting：防双击；graded：提交成功后的展示态
  const [phase, setPhase] = useState<"answering" | "submitting" | "graded">("answering");
  const [graded, setGraded] = useState<PopQuizGradedQuestion[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  // 卡片换新 quiz 时全部状态归零（重播同 quizId 不触发：id 不变）
  useEffect(() => {
    setPage(0);
    setDrafts({});
    setPhase("answering");
    setGraded([]);
    setErrorText(null);
  }, [interaction.id]);

  const current = questions[Math.min(page, questions.length - 1)];
  const canSubmit = questions.every((question) => isQuizQuestionAnswered(question, drafts[question.id]));

  const submit = async () => {
    if (!canSubmit || phase !== "answering" || !onSubmit) return;
    setPhase("submitting");
    setErrorText(null);
    try {
      const result = await onSubmit({
        quizId: interaction.id,
        answers: questions.map((question) => ({
          questionId: question.id,
          ...drafts[question.id],
        })),
      });
      if (result.ok && result.graded) {
        setGraded(result.graded);
        setPhase("graded");
        return;
      }
      // 校验失败：pending 还开着，用户补答后可重交
      if (result.error === "E_QUIZ_ANSWER_INCOMPLETE") {
        setErrorText(t("interaction.quizIncompleteError"));
      } else if (result.error === "E_QUIZ_NOT_FOUND") {
        setErrorText(t("interaction.quizNotFoundError"));
      } else {
        setErrorText(t("interaction.quizInvalidError"));
      }
      setPhase("answering");
    } catch {
      setErrorText(t("interaction.quizInvalidError"));
      setPhase("answering");
    }
  };

  const skip = async () => {
    if (!onSkip || phase === "submitting") return;
    await onSkip(interaction.id).catch(() => undefined);
    // 不本地清卡：主进程结算 skipped 后广播，ChatPage 统一移除
  };

  const trueFalseOptions = [
    { value: true, label: t("interaction.quizTrueLabel") },
    { value: false, label: t("interaction.quizFalseLabel") },
  ];

  // ── 展示态：全部题目纵向铺开，逐题显示对错与解析 ──
  if (phase === "graded") {
    const gradedById = new Map(graded.map((item) => [item.questionId, item]));
    return (
      <PanelShell title={t("interaction.quizTitle")}>
        <img src={moodWarmUrl} className="cy-interaction-panel__mood-bottom-left" alt="" />
        <div className="cy-interaction-panel__heading">
          <span className="cy-interaction-panel__status"><img src={moodLearnUrl} alt="" />{t("interaction.quizGradedTitle")}</span>
        </div>
        <div className="cy-quiz-graded">
          {questions.map((question) => {
            const result = gradedById.get(question.id);
            const grading = result?.grading ?? "pending_model";
            const userDraft = drafts[question.id];
            const userAnswer = question.type === "choice" ? userDraft?.optionId && question.options.find((o) => o.id === userDraft.optionId)?.label
              : question.type === "multi" ? (userDraft?.optionIds ?? []).map((id) => question.options.find((o) => o.id === id)?.label).filter(Boolean).join("、")
              : question.type === "true_false" ? (userDraft?.boolean === true ? t("interaction.quizTrueLabel") : userDraft?.boolean === false ? t("interaction.quizFalseLabel") : "—")
              : userDraft?.text?.trim() || "—";
            return (
              <div key={question.id} className={`cy-quiz-graded__item is-${grading}`}>
                <div className="cy-interaction-panel__question">
                  <MarkdownContent content={question.question} />
                </div>
                <div className="cy-quiz-graded__meta">
                  <span className={`cy-quiz-badge is-${grading}`}>
                    {grading === "correct" ? t("interaction.quizGradedCorrect")
                      : grading === "incorrect" ? t("interaction.quizGradedIncorrect")
                      : t("interaction.quizGradedPending")}
                  </span>
                  <div className="cy-quiz-graded__answer">
                    {t("interaction.quizYourAnswer")}：<MarkdownContent content={userAnswer ?? ""} />
                  </div>
                  {result?.correctAnswer !== undefined && (
                    <div className="cy-quiz-graded__answer">
                      {t("interaction.quizCorrectAnswer")}：<MarkdownContent content={describeQuizAnswerValue(question, result.correctAnswer, { true: t("interaction.quizTrueLabel"), false: t("interaction.quizFalseLabel") })} />
                    </div>
                  )}
                </div>
                {/* 简答题不立即展示解析：标准答案要点由 Cyrene 讲评时给出，避免剧透 */}
                {result?.explanation && grading !== "pending_model" && (
                  <div className="cy-quiz-graded__explanation">
                    <MarkdownContent content={result.explanation} />
                  </div>
                )}
                {grading === "pending_model" && (
                  <p className="cy-quiz-graded__pending">{t("interaction.quizPendingHint")}</p>
                )}
              </div>
            );
          })}
        </div>
      </PanelShell>
    );
  }

  // ── 作答态：逐题作答，全部答完才能提交 ──
  return (
    <PanelShell title={t("interaction.quizTitle")}>
      <img src={moodWarmUrl} className="cy-interaction-panel__mood-bottom-left" alt="" />
      <div className="cy-interaction-panel__heading">
        <span className="cy-interaction-panel__status"><img src={moodLearnUrl} alt="" />{t("interaction.quizTitle")}</span>
        {questions.length > 1 && (
          <nav className="cy-interaction-panel__pager" aria-label={t("interaction.pagerAria")}>
            <button type="button" aria-label={t("interaction.prevQuestion")} disabled={disabled || phase === "submitting" || page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>‹</button>
            <span className="cy-interaction-panel__page">{page + 1} / {questions.length}</span>
            <button type="button" aria-label={t("interaction.nextQuestion")} disabled={disabled || phase === "submitting" || page === questions.length - 1} onClick={() => setPage((value) => Math.min(questions.length - 1, value + 1))}>›</button>
          </nav>
        )}
      </div>
      {interaction.intro && <p className="cy-interaction-panel__intro">{interaction.intro}</p>}
      <div className="cy-interaction-panel__question">
        <MarkdownContent content={current.question} />
      </div>
      {current.learningObjective && (
        <div className="cy-quiz-objective">
          {t("interaction.quizObjectiveLabel")}：<MarkdownContent content={current.learningObjective} />
        </div>
      )}
      {(current.type === "choice" || current.type === "multi") && (
        <div className="cy-interaction-panel__options" role={current.type === "multi" ? "group" : "radiogroup"} aria-label={current.question}>
          {current.options.map((option, index) => {
            const selected = current.type === "choice"
              ? drafts[current.id]?.optionId === option.id
              : (drafts[current.id]?.optionIds ?? []).includes(option.id);
            return (
              <button
                type="button"
                key={option.id}
                className={selected ? "is-selected" : ""}
                role={current.type === "multi" ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={disabled || phase === "submitting"}
                onClick={() => {
                  setDrafts((values) => {
                    const prev = values[current.id] ?? {};
                    if (current.type === "choice") {
                      return { ...values, [current.id]: { ...prev, optionId: option.id } };
                    }
                    const prevIds = prev.optionIds ?? [];
                    const optionIds = prevIds.includes(option.id)
                      ? prevIds.filter((id) => id !== option.id)
                      : [...prevIds, option.id];
                    return { ...values, [current.id]: { ...prev, optionIds } };
                  });
                }}
              >
                <span className="cy-interaction-panel__option-index">{index + 1}.</span>
                <div className="cy-interaction-panel__option-body">
                  <MarkdownContent content={option.label} />
                </div>
              </button>
            );
          })}
        </div>
      )}
      {current.type === "true_false" && (
        <div className="cy-interaction-panel__options" role="radiogroup" aria-label={current.question}>
          {trueFalseOptions.map((option) => (
            <button
              type="button"
              key={String(option.value)}
              className={drafts[current.id]?.boolean === option.value ? "is-selected" : ""}
              role="radio"
              aria-checked={drafts[current.id]?.boolean === option.value}
              disabled={disabled || phase === "submitting"}
              onClick={() => setDrafts((values) => ({ ...values, [current.id]: { ...values[current.id], boolean: option.value } }))}
            >
              <span className="cy-interaction-panel__option-index">◦</span>
              <span><strong>{option.label}</strong></span>
            </button>
          ))}
        </div>
      )}
      {current.type === "short_answer" && (
        <label className="cy-interaction-panel__custom-answer">
          <span>{t("interaction.quizShortAnswerLabel")}</span>
          <textarea
            className="cy-quiz-short-answer"
            value={drafts[current.id]?.text ?? ""}
            disabled={disabled || phase === "submitting"}
            placeholder={t("interaction.quizShortAnswerPlaceholder")}
            rows={3}
            onChange={(event) => setDrafts((values) => ({ ...values, [current.id]: { ...values[current.id], text: event.target.value } }))}
          />
        </label>
      )}
      {questions.length > 1 && (
        <div className="cy-interaction-panel__question-index" aria-label={t("interaction.questionProgressAria")}>
          {questions.map((question, index) => {
            const answered = isQuizQuestionAnswered(question, drafts[question.id]);
            return <button type="button" key={question.id} className={page === index ? "is-current" : ""} disabled={disabled || phase === "submitting"} onClick={() => setPage(index)}>{answered ? "✓" : "○"} {index + 1}</button>;
          })}
        </div>
      )}
      {errorText && <p className="cy-quiz-error" role="alert">{errorText}</p>}
      <div className="cy-interaction-panel__actions">
        <button type="button" className="cy-quiz-skip" disabled={disabled || phase === "submitting"} onClick={() => void skip()}>{t("interaction.quizSkip")}</button>
        <button type="button" className="is-primary" disabled={disabled || phase === "submitting" || !canSubmit} onClick={() => void submit()}>
          {phase === "submitting" ? t("interaction.quizSubmitting") : t("interaction.quizSubmit")}
        </button>
      </div>
    </PanelShell>
  );
}
