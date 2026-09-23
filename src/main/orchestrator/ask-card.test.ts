import { describe, expect, it } from "vitest";
import {
  buildAskCard,
  publishAskCard,
  resolveAskCardSubmission,
  validateAskUserAnswer,
} from "./ask-card";

describe("buildAskCard", () => {
  it("keeps at most three model options and leaves custom input outside the option list", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "markdown", label: "Markdown 文档" },
          { value: "pdf", label: "PDF 文档" },
          { value: "excel", label: "Excel 表格" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(card.questions[0].options).toEqual([
      { value: "word", label: "Word 文档" },
      { value: "markdown", label: "Markdown 文档" },
      { value: "pdf", label: "PDF 文档" },
    ]);
    expect(card.questions[0].allowCustom).toBe(true);
  });

  it("allows a text question without suggestions", () => {
    expect(buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "topic",
        question: "这份文档主要写什么？",
        type: "text",
        options: [],
        allowCustom: true,
        freeTextPlaceholder: "填写主题",
      }],
      deferredFields: [],
    }).questions[0]).toMatchObject({ type: "text", options: [] });
  });

  it("rejects a select question with fewer than two usable suggestions", () => {
    expect(() => buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "topic",
        question: "这份文档主要写什么？",
        type: "single_select",
        options: [{ value: "项目说明", label: "项目说明" }],
        allowCustom: false,
        freeTextPlaceholder: "填写其他主题",
      }],
      deferredFields: [],
    })).toThrow("E_ASK_OPTIONS_INSUFFICIENT");
  });

  it("rejects answer values that were not presented by Runtime", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "pdf", label: "PDF 文档" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(() => validateAskUserAnswer(card, "choice-1", {
      requestId: "forged",
      answers: [{ field: "format", selectedValues: ["shell"] }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });

  it("publishes opaque option ids without exposing canonical values", () => {
    const card = buildAskCard({
      intro: "还需要确认两个细节。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    const publication = publishAskCard(card, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
    });

    expect(publication.payload).toEqual({
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      mode: "semantic_clarification",
      intro: "还需要确认两个细节。",
      questions: [{
        id: "question-1",
        prompt: "希望生成哪种格式？",
        multiple: false,
        required: true,
        options: [
          { id: "question-1-option-1", label: "Word" },
          { id: "question-1-option-2", label: "PDF" },
        ],
        customInput: { enabled: false, placeholder: "填写其他格式" },
      }],
    });
    expect(JSON.stringify(publication.payload)).not.toContain("docx");
  });

  it("publishes an action-parameter card without exposing its pending action", () => {
    const card = buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }, "action_parameters");
    const publication = publishAskCard(card, {
      interactionId: "choice-2",
      runId: "run-2",
      revision: 1,
    });

    expect(publication.payload.mode).toBe("action_parameters");
    expect(JSON.stringify(publication.payload)).not.toContain("write_document");
    expect(JSON.stringify(publication.payload)).not.toContain("argumentPath");
    expect(JSON.stringify(publication.payload)).not.toContain("docx");
  });

  it("maps an optionId back to its private canonical value", () => {
    const publication = publishAskCard(buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }), { interactionId: "choice-1", runId: "run-1", revision: 1 });

    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-2" }],
    })).toEqual({
      requestId: "choice-1",
      answers: [{ field: "format", selectedValues: ["pdf"] }],
    });
  });

  it("rejects forged option ids and accepts custom text as the exclusive answer", () => {
    const publication = publishAskCard(buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }), { interactionId: "choice-1", runId: "run-1", revision: 1 });

    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option", optionId: "forged" }],
    })).toThrow("E_ASK_ANSWER_INVALID");

    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "custom", text: "  HTML  " }],
    })).toEqual({
      requestId: "choice-1",
      answers: [{ field: "format", customText: "HTML" }],
    });
  });

  it("maps a plan revise decision with its feedback text in one answer", () => {
    const publication = publishAskCard({
      mode: "plan_approval",
      intro: "计划已提交，请审阅计划内容后决定",
      questions: [{
        field: "plan_decision",
        question: "是否批准此计划？",
        type: "single_select",
        options: [
          { value: "approve", label: "批准" },
          { value: "revise", label: "需要修改" },
          { value: "reject", label: "不批准" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "请描述你想修改的内容…",
      }],
      deferredFields: [],
    }, { interactionId: "choice-plan", runId: "run-plan", revision: 1 });

    // 档位与意见同卡回传：选项映射 canonical 值，意见原文 trim 后随行
    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 1,
      answers: [{
        questionId: "question-1",
        source: "option_with_text",
        optionId: "question-1-option-2",
        text: "  第三步改成先写测试  ",
      }],
    })).toEqual({
      requestId: "choice-plan",
      answers: [{ field: "plan_decision", selectedValues: ["revise"], customText: "第三步改成先写测试" }],
    });

    // 空意见：没有信息量的"需要修改"一律拒绝
    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option_with_text", optionId: "question-1-option-2", text: "   " }],
    })).toThrow("E_ASK_ANSWER_INVALID");
    // 伪造选项 id：同选项规则拒绝
    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option_with_text", optionId: "forged", text: "意见" }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });

  it("does not accept option_with_text for a runtime-owned fixed-choice card", () => {
    const publication = publishAskCard({
      mode: "semantic_clarification",
      intro: "确认一下。",
      questions: [{
        field: "decision",
        question: "是否继续？",
        type: "single_select",
        options: [
          { value: "yes", label: "继续" },
          { value: "no", label: "停止" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "",
      }],
      deferredFields: [],
    }, { interactionId: "choice-fixed", runId: "run-fixed", revision: 1 });

    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-fixed",
      runId: "run-fixed",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option_with_text", optionId: "question-1-option-1", text: "附言" }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });

  it("publishes mixed single, multiple, and text questions with their real custom-input policy", () => {
    const publication = publishAskCard({
      mode: "semantic_clarification",
      intro: "确认三件事。",
      questions: [
        {
          field: "format",
          question: "格式？",
          type: "single_select",
          options: [{ value: "md", label: "Markdown" }, { value: "docx", label: "Word" }],
          allowCustom: true,
          freeTextPlaceholder: "其他格式",
        },
        {
          field: "sections",
          question: "包含哪些章节？",
          type: "multi_select",
          options: [{ value: "summary", label: "摘要" }, { value: "risks", label: "风险" }],
          allowCustom: true,
          freeTextPlaceholder: "其他章节",
        },
        {
          field: "note",
          question: "还有什么要求？",
          type: "text",
          options: [],
          allowCustom: true,
          freeTextPlaceholder: "请输入要求",
        },
      ],
      deferredFields: [],
    }, { interactionId: "choice-mixed", runId: "run-mixed", revision: 1 });

    expect(publication.payload.questions).toMatchObject([
      { multiple: false, customInput: { enabled: true } },
      { multiple: true, customInput: { enabled: true } },
      { multiple: false, options: [], customInput: { enabled: true } },
    ]);

    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-mixed",
      runId: "run-mixed",
      revision: 1,
      answers: [
        { questionId: "question-1", source: "option", optionId: "question-1-option-1" },
        { questionId: "question-2", source: "option", optionIds: ["question-2-option-1", "question-2-option-2"] },
        { questionId: "question-3", source: "custom", text: "停止当前任务" },
      ],
    })).toEqual({
      requestId: "choice-mixed",
      answers: [
        { field: "format", selectedValues: ["md"] },
        { field: "sections", selectedValues: ["summary", "risks"] },
        { field: "note", customText: "停止当前任务" },
      ],
    });
  });

  it("does not accept custom text for a runtime-owned fixed-choice card", () => {
    const publication = publishAskCard({
      mode: "semantic_clarification",
      intro: "安全确认。",
      questions: [{
        field: "decision",
        question: "是否继续？",
        type: "single_select",
        options: [{ value: "allow", label: "允许" }, { value: "deny", label: "拒绝" }],
        allowCustom: false,
        freeTextPlaceholder: "",
      }],
      deferredFields: [],
    }, { interactionId: "choice-fixed", runId: "run-fixed", revision: 1 });

    expect(publication.payload.questions[0].customInput.enabled).toBe(false);
    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-fixed",
      runId: "run-fixed",
      revision: 1,
      answers: [{ questionId: "question-1", source: "custom", text: "仍然继续" }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });
});
