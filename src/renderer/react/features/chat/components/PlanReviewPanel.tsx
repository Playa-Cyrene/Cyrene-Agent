// PlanContent — 计划清单内容（由 RightInspector 容器承载）。
//
// 渲染复用聊天正文的 MarkdownContent（Streamdown + 代码高亮），
// 与模型回复的 md 渲染保持完全一致；阶段色点与提示由 RightInspector 顶部 tab 提供。
// 入口 chip（PlanReviewEntry）由 Code Todo 卡片承载，点击打开右侧面板。

import { t, useTranslation } from "../../../i18n";
import { MarkdownContent } from "./ChatMessageList";

export type PlanReviewPhase = "review" | "executing" | "completed";

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件/调用处求值。
const PHASE_NOTE_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.noteReview",
  executing: "planReview.noteExecuting",
  completed: "planReview.noteCompleted",
};

const PHASE_DOT: Record<PlanReviewPhase, string> = {
  review: "is-review",
  executing: "is-executing",
  completed: "is-completed",
};

const PHASE_LABEL_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.tabReview",
  executing: "planReview.tabExecuting",
  completed: "planReview.tabCompleted",
};

const ENTRY_LABEL_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.entryReview",
  executing: "planReview.entryExecuting",
  completed: "planReview.entryCompleted",
};

export function PlanContent({
  content,
  phase = "review",
}: {
  content: string;
  phase?: PlanReviewPhase;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-plan-content">
      <p className="cy-plan-content__note">{t(PHASE_NOTE_KEYS[phase])}</p>
      <div className="cy-plan-content__body">
        <MarkdownContent content={content} />
      </div>
    </div>
  );
}

export function planTabLabel(phase: PlanReviewPhase): string {
  return t(PHASE_LABEL_KEYS[phase]);
}

export function planTabDotClass(phase: PlanReviewPhase): string {
  return PHASE_DOT[phase];
}

/** Code Todo 卡片底部的小入口按钮：点击打开右侧计划面板。 */
export function PlanReviewEntry({
  phase,
  onOpen,
}: {
  phase: PlanReviewPhase;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`cy-plan-entry is-${phase}`} onClick={onOpen}>
      <span className={`cy-plan-entry__dot ${PHASE_DOT[phase]}`} aria-hidden="true" />
      {t(ENTRY_LABEL_KEYS[phase])}
    </button>
  );
}
