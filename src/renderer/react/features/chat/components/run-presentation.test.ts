import { describe, expect, it } from "vitest";
import {
  buildAskSubmission,
  buildPlanApprovalSubmission,
  createAskDrafts,
  describePermissionRequest,
  describeRunStage,
  isAskComplete,
  normalizeChoiceInteraction,
  normalizePopQuizCard,
  normalizeTaskPlanPresentation,
  resolveComposerSlot,
  selectAskOption,
  shouldDismissAsk,
  updateAskCustomText,
  type ComposerInteraction,
} from "./run-presentation";
import * as runPresentation from "./run-presentation";

describe("work run presentation", () => {
  it("replaces the composer only while an ask or permission interaction is pending", () => {
    const ask: ComposerInteraction = {
      kind: "ask",
      id: "ask-1",
      question: "你想先处理哪一项？",
      options: [{ id: "one", label: "第一项" }],
    };
    const permission: ComposerInteraction = {
      kind: "permission",
      id: "approve-1",
      toolName: "write_word",
      summary: "在工作区创建报告",
    };

    expect(resolveComposerSlot(undefined)).toBe("composer");
    expect(resolveComposerSlot(ask)).toBe("ask");
    expect(resolveComposerSlot(permission)).toBe("permission");
  });

  it("keeps internal routing out of the user-facing stage copy", () => {
    expect(describeRunStage({ kind: "understanding" })).toBe("昔涟正在理解需求…");
    expect(describeRunStage({ kind: "planning" })).toBe("昔涟正在规划任务…");
    expect(describeRunStage({ kind: "executing", detail: "查询淄博天气" }))
      .toBe("昔涟正在执行：查询淄博天气…");
    expect(describeRunStage({ kind: "waiting_permission" })).toBe("昔涟正在获取审批…");
    expect(describeRunStage({ kind: "waiting_user" })).toBe("昔涟正在询问…");
    expect(describeRunStage({ kind: "responding" })).toBe("昔涟正在组织回复…");
  });

  it("reduces permission requests to the action a person needs to approve", () => {
    expect(describePermissionRequest({
      toolId: "weather",
      toolName: "查天气",
      args: { city: "淄博" },
    })).toBe("查询淄博天气");
    expect(describePermissionRequest({
      toolId: "web_search",
      toolName: "搜索网页",
      args: { query: "今天的科技新闻" },
    })).toBe("搜索“今天的科技新闻”");
    expect(describePermissionRequest({
      toolId: "write_word",
      toolName: "写入 Word",
      args: { filename: "日报.docx" },
    })).toBe("创建 Word 文档：日报.docx");
    expect(describePermissionRequest({
      toolId: "unknown_tool",
      toolName: "自定义操作",
      args: {},
    })).toBe("执行「自定义操作」");
  });

  it("normalizes both legacy choices and structured clarification into the same composer slot", () => {
    expect(normalizeChoiceInteraction({
      id: "choice-1",
      question: "要生成哪一种报告？",
      options: [{ value: "daily", label: "日报", description: "汇总今天的信息" }],
    })).toMatchObject({
      kind: "ask",
      id: "choice-1",
      responseKind: "choice",
      options: [{ id: "daily", label: "日报" }],
    });

    expect(normalizeChoiceInteraction({
      id: "choice-2",
      intro: "还需要确认两个细节。",
      questions: [{
        field: "format",
        question: "想要什么格式？",
        type: "single_select",
        allowCustom: false,
        freeTextPlaceholder: "",
        options: [{ value: "docx", label: "Word" }],
      }],
    })).toMatchObject({
      kind: "ask",
      id: "choice-2",
      responseKind: "clarification",
      questions: [{ id: "format", options: [{ id: "docx", label: "Word" }] }],
    });
  });

  it("normalizes the opaque public Ask payload without requiring canonical option values", () => {
    expect(normalizeChoiceInteraction({
      interactionId: "choice-3",
      runId: "run-7",
      revision: 2,
      mode: "semantic_clarification",
      intro: "还需要确认两个细节。",
      questions: [{
        id: "question-1",
        prompt: "希望生成哪种格式？",
        required: true,
        multiple: false,
        options: [
          { id: "option-word", label: "Word" },
          { id: "option-pdf", label: "PDF" },
        ],
        customInput: { enabled: true, placeholder: "填写其他格式" },
      }],
    })).toEqual({
      kind: "ask",
      id: "choice-3",
      runId: "run-7",
      revision: 2,
      cardMode: "semantic_clarification",
      intro: "还需要确认两个细节。",
      responseKind: "submission",
      question: "希望生成哪种格式？",
      options: [
        { id: "option-word", label: "Word" },
        { id: "option-pdf", label: "PDF" },
      ],
      questions: [{
        id: "question-1",
        question: "希望生成哪种格式？",
        options: [
          { id: "option-word", label: "Word" },
          { id: "option-pdf", label: "PDF" },
        ],
        allowCustomInput: true,
        freeTextPlaceholder: "填写其他格式",
        multiple: false,
      }],
    });
  });

  it("normalizes a required text-only Ask question", () => {
    expect(normalizeChoiceInteraction({
      interactionId: "choice-text",
      runId: "run-text",
      revision: 1,
      mode: "semantic_clarification",
      intro: "还需要一句补充。",
      questions: [{
        id: "note",
        prompt: "还有什么要求？",
        required: true,
        multiple: false,
        options: [],
        customInput: { enabled: true, placeholder: "请输入要求" },
      }],
    })).toMatchObject({
      kind: "ask",
      id: "choice-text",
      responseKind: "submission",
      questions: [{
        id: "note",
        options: [],
        allowCustomInput: true,
        multiple: false,
      }],
    });
  });

  it("accepts a runtime-owned fixed-choice card with custom input disabled", () => {
    expect(normalizeChoiceInteraction({
      interactionId: "confirm-1",
      runId: "run-1",
      revision: 1,
      mode: "semantic_clarification",
      questions: [{
        id: "decision",
        prompt: "是否仍要允许下一次相同操作？",
        required: true,
        multiple: false,
        options: [
          { id: "allow", label: "仍然允许" },
          { id: "deny", label: "不要重复" },
        ],
        customInput: { enabled: false, placeholder: "" },
      }],
    })).toMatchObject({
      id: "confirm-1",
      questions: [{ id: "decision", allowCustomInput: false }],
    });
  });

  it("keeps unordered multi-question drafts and enforces option XOR custom", () => {
    const interaction = normalizeChoiceInteraction({
      interactionId: "choice-4",
      runId: "run-8",
      revision: 1,
      mode: "semantic_clarification",
      intro: "确认两件事。",
      questions: [
        {
          id: "q1",
          prompt: "格式？",
          required: true,
          multiple: false,
          options: [{ id: "word", label: "Word" }, { id: "pdf", label: "PDF" }],
          customInput: { enabled: true },
        },
        {
          id: "q2",
          prompt: "语气？",
          required: true,
          multiple: false,
          options: [{ id: "formal", label: "正式" }, { id: "light", label: "轻松" }],
          customInput: { enabled: true },
        },
      ],
    })!;
    let drafts = createAskDrafts(interaction.questions!);
    drafts = updateAskCustomText(drafts, "q2", "  活泼一点  ");
    expect(isAskComplete(interaction.questions!, drafts)).toBe(false);
    drafts = selectAskOption(drafts, interaction.questions![0], "word");
    drafts = selectAskOption(drafts, interaction.questions![1], "formal");
    expect(drafts.q2).toEqual({ source: "option", optionIds: ["formal"], customText: "" });
    expect(isAskComplete(interaction.questions!, drafts)).toBe(true);
    drafts = updateAskCustomText(drafts, "q2", "活泼一点");
    expect(drafts.q2).toEqual({ source: "custom", optionIds: [], customText: "活泼一点" });

    expect(buildAskSubmission(interaction, drafts)).toEqual({
      interactionId: "choice-4",
      runId: "run-8",
      revision: 1,
      answers: [
        { questionId: "q1", source: "option", optionId: "word" },
        { questionId: "q2", source: "custom", text: "活泼一点" },
      ],
    });
  });

  it("dismisses an Ask only for the matching run and revision", () => {
    const interaction = normalizeChoiceInteraction({
      interactionId: "choice-5",
      runId: "run-current",
      revision: 4,
      mode: "semantic_clarification",
      intro: "确认一下。",
      questions: [{
        id: "q1",
        prompt: "选择？",
        required: true,
        multiple: false,
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        customInput: { enabled: true },
      }],
    })!;

    expect(shouldDismissAsk(interaction, {
      id: "choice-5",
      runId: "run-old",
      revision: 4,
      reason: "timeout",
    })).toBe(false);
    expect(shouldDismissAsk(interaction, {
      id: "choice-5",
      runId: "run-current",
      revision: 4,
      reason: "timeout",
    })).toBe(true);
  });

  it("keeps the plan_approval card mode so the composer slot can route to the approval panel", () => {
    const payload = {
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 1,
      mode: "plan_approval",
      intro: "计划已提交，请审阅计划内容后决定",
      questions: [{
        id: "question-1",
        prompt: "是否批准此计划？",
        required: true,
        multiple: false,
        options: [
          { id: "question-1-option-1", label: "批准" },
          { id: "question-1-option-2", label: "需要修改" },
          { id: "question-1-option-3", label: "不批准" },
        ],
        customInput: { enabled: true, placeholder: "请描述你想修改的内容…" },
      }],
    };

    expect(normalizeChoiceInteraction(payload)).toMatchObject({
      kind: "ask",
      id: "choice-plan",
      cardMode: "plan_approval",
      responseKind: "submission",
    });
    // 未知 mode 不进 plan_approval 分支，普通询问卡照常渲染
    expect(normalizeChoiceInteraction({ ...payload, mode: "unknown_mode" })).toMatchObject({
      cardMode: undefined,
    });
  });

  it("builds plan approval submissions by option position with revise text attached", () => {
    const interaction = normalizeChoiceInteraction({
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 3,
      mode: "plan_approval",
      intro: "计划已提交，请审阅计划内容后决定",
      questions: [{
        id: "question-1",
        prompt: "是否批准此计划？",
        required: true,
        multiple: false,
        options: [
          { id: "question-1-option-1", label: "批准" },
          { id: "question-1-option-2", label: "需要修改" },
          { id: "question-1-option-3", label: "不批准" },
        ],
        customInput: { enabled: true, placeholder: "请描述你想修改的内容…" },
      }],
    })!;

    // 位置契约：第 1 个=批准、第 2 个=需要修改、第 3 个=不批准
    expect(buildPlanApprovalSubmission(interaction, "approve")).toEqual({
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 3,
      answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-1" }],
    });
    expect(buildPlanApprovalSubmission(interaction, "reject")).toEqual({
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 3,
      answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-3" }],
    });
    expect(buildPlanApprovalSubmission(interaction, "revise", "  第三步改成先写测试  ")).toEqual({
      interactionId: "choice-plan",
      runId: "run-plan",
      revision: 3,
      answers: [{
        questionId: "question-1",
        source: "option_with_text",
        optionId: "question-1-option-2",
        text: "第三步改成先写测试",
      }],
    });

    // 空意见 / 非 plan_approval 卡：拒绝构造提交
    expect(() => buildPlanApprovalSubmission(interaction, "revise", "   ")).toThrow("E_ASK_SUBMISSION_INCOMPLETE");
    expect(() => buildPlanApprovalSubmission(interaction, "revise")).toThrow("E_ASK_SUBMISSION_INCOMPLETE");
    const plain = { ...interaction, cardMode: undefined } as typeof interaction;
    expect(() => buildPlanApprovalSubmission(plain, "approve")).toThrow("E_ASK_SUBMISSION_INCOMPLETE");
  });

  it("keeps one plan card updated from task-plan snapshots", () => {
    expect(normalizeTaskPlanPresentation({
      goal: "整理今日信息",
      steps: [
        { stepId: "s1", objective: "搜索新闻", status: "completed" },
        { stepId: "s2", objective: "生成报告", status: "running" },
        { stepId: "s3", objective: "清理旧文件", status: "superseded" },
      ],
    })).toEqual({
      title: "整理今日信息",
      steps: [
        { id: "s1", title: "搜索新闻", status: "completed" },
        { id: "s2", title: "生成报告", status: "running" },
        { id: "s3", title: "清理旧文件", status: "pending" },
      ],
    });
  });

  it("normalizes a valid pop quiz card and gives it its own composer slot", () => {
    const card = {
      quizId: "quiz-1-1",
      runId: "run-quiz",
      intro: "答完这几题看看掌握没有。",
      questions: [
        {
          id: "q1",
          type: "choice",
          question: "true + true 的结果是？",
          options: [
            { id: "q1-opt-1", label: "2" },
            { id: "q1-opt-2", label: "true" },
          ],
          learningObjective: "布尔值的隐式类型转换",
        },
        {
          id: "q2",
          type: "short_answer",
          question: "用自己的话说说什么是闭包。",
          options: [],
          learningObjective: "闭包的概念",
        },
      ],
    };
    const interaction = normalizePopQuizCard(card)!;
    expect(interaction).toEqual({
      kind: "quiz",
      id: "quiz-1-1",
      runId: "run-quiz",
      intro: "答完这几题看看掌握没有。",
      questions: [
        {
          id: "q1",
          type: "choice",
          question: "true + true 的结果是？",
          options: [
            { id: "q1-opt-1", label: "2" },
            { id: "q1-opt-2", label: "true" },
          ],
          learningObjective: "布尔值的隐式类型转换",
        },
        {
          id: "q2",
          type: "short_answer",
          question: "用自己的话说说什么是闭包。",
          options: [],
          learningObjective: "闭包的概念",
        },
      ],
    });
    expect(resolveComposerSlot(interaction)).toBe("quiz");
  });

  it("rejects malformed pop quiz payloads instead of rendering half a card", () => {
    const valid = {
      quizId: "quiz-2-1",
      runId: "run-quiz",
      intro: "",
      questions: [{
        id: "q1",
        type: "true_false",
        question: "1 + 1 === 2",
        options: [],
        learningObjective: "",
      }],
    };
    // 完整合法的卡片本身可以通过
    expect(normalizePopQuizCard(valid)).toBeDefined();
    // 缺 quizId / runId / questions：直接失效
    expect(normalizePopQuizCard({ ...valid, quizId: "" })).toBeUndefined();
    expect(normalizePopQuizCard({ ...valid, runId: "" })).toBeUndefined();
    expect(normalizePopQuizCard({ ...valid, questions: "not-array" })).toBeUndefined();
    // 题型不在四种之内：整卡失效
    expect(normalizePopQuizCard({
      ...valid,
      questions: [{ ...valid.questions[0], type: "fill_blank" }],
    })).toBeUndefined();
    // 选择题选项不足 2 个：整卡失效（渲染出来也没法答）
    expect(normalizePopQuizCard({
      ...valid,
      questions: [{
        id: "q1",
        type: "choice",
        question: "选一个",
        options: [{ id: "q1-opt-1", label: "唯一选项" }],
        learningObjective: "",
      }],
    })).toBeUndefined();
    // 题目数组里有任何一题废掉，不能只渲染剩下那半张卡
    expect(normalizePopQuizCard({
      ...valid,
      questions: [valid.questions[0], { id: "q2", type: "choice", question: "", options: [] }],
    })).toBeUndefined();
  });
});
