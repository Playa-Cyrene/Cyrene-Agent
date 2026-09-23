import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../vendors/types";
import type { ToolContext } from "../tools/registry/tool-context";
import {
  ENTER_PLAN_MODE_TOOL_ID,
  WRITE_PLAN_TOOL_ID,
  SUBMIT_PLAN_TOOL_ID,
  buildPlanApprovalCard,
  executeEnterPlanMode,
  executeWritePlan,
  executeSubmitPlan,
} from "./plan-tools";
import {
  approvePlan,
  enterPlanDiscussing,
  getPlanPath,
  getPlanState,
  hasPlanWrittenThisRun,
  initPlanPaths,
  markPlanWritten,
  moveToReview,
  resetPlanSessionsForTest,
} from "../plan-mode";
import { toastEvents } from "../../toast/toast-events";

const PLAN_CONTENT = [
  "# 实施计划",
  "",
  "- [ ] 第一步：写测试",
  "- [ ] 第二步：跑通",
  "",
  "## 风险与回退",
  "",
  "出问题就回滚。",
].join("\n");

let workspaceRoot: string;

function makeCall(args: Record<string, unknown>, name = WRITE_PLAN_TOOL_ID, rawArguments?: string): ToolCall {
  return { id: "call-1", name, arguments: rawArguments ?? JSON.stringify(args) };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userQuery: "帮我做个计划",
    conversationId: "conv-1",
    resolvedWorkspaceRoot: workspaceRoot,
    ...overrides,
  };
}

/** 同一秒内两次进入计划模式会生成同名文件；直接读当前活动 planPath 校验落盘内容。 */
async function readActivePlan(conversationId: string): Promise<string> {
  const { getPlanPath } = await import("../plan-mode");
  return fs.promises.readFile(getPlanPath(conversationId), "utf8");
}

describe("plan-tools", () => {
  beforeEach(() => {
    resetPlanSessionsForTest();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tools-ws-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe("executeEnterPlanMode", () => {
    it("NORMAL 状态成功进入并发 plan_mode_changed 事件", async () => {
      const events: { type: string; state?: string }[] = [];
      const observation = await executeEnterPlanMode(
        makeCall({}, ENTER_PLAN_MODE_TOOL_ID),
        makeCtx(),
        (event) => events.push(event as { type: string; state?: string }),
      );

      expect(observation.outcome).toBe("success");
      expect(observation.tool).toBe(ENTER_PLAN_MODE_TOOL_ID);
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
      expect(events).toEqual([{ type: "plan_mode_changed", state: "PLAN_DISCUSSING" }]);
    });

    it("计划路径落在工作区 .cyrene/docs 下", async () => {
      await executeEnterPlanMode(makeCall({}, ENTER_PLAN_MODE_TOOL_ID), makeCtx());
      const { getPlanPath } = await import("../plan-mode");

      const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      expect(getPlanPath("conv-1")).toMatch(
        new RegExp(`^${normalizedRoot}/\\.cyrene/docs/plan-\\d{8}-\\d{6}\\.md$`),
      );
    });

    it("已在 PLAN_DISCUSSING 时幂等拒绝且不发事件", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      const events: unknown[] = [];

      const observation = await executeEnterPlanMode(
        makeCall({}, ENTER_PLAN_MODE_TOOL_ID),
        makeCtx(),
        (event) => events.push(event),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("已在计划模式中");
      expect(events).toEqual([]);
    });

    it("PLAN_REVIEW 时拒绝（等待用户审批）", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      markPlanWritten("conv-1");
      expect(moveToReview("conv-1")).toBe(true);

      const observation = await executeEnterPlanMode(makeCall({}, ENTER_PLAN_MODE_TOOL_ID), makeCtx());

      expect(observation.outcome).toBe("failure");
      expect(observation.message).toContain("计划待审批");
    });

    it("EXECUTING 时拒绝", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      markPlanWritten("conv-1");
      moveToReview("conv-1");
      approvePlan("conv-1");

      const observation = await executeEnterPlanMode(makeCall({}, ENTER_PLAN_MODE_TOOL_ID), makeCtx());

      expect(observation.outcome).toBe("failure");
      expect(observation.message).toContain("计划执行中");
    });

    it("无 ctx 时回落 default 会话", async () => {
      const observation = await executeEnterPlanMode(makeCall({}, ENTER_PLAN_MODE_TOOL_ID), undefined);

      expect(observation.outcome).toBe("success");
      expect(getPlanState("default")).toBe("PLAN_DISCUSSING");
    });
  });

  describe("executeWritePlan", () => {
    it("非 PLAN_DISCUSSING 状态拒绝写入", async () => {
      const observation = await executeWritePlan(makeCall({ content: PLAN_CONTENT }), makeCtx());

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("write_plan 仅在计划讨论状态可用");
    });

    it.each([
      ["content 缺失", {}],
      ["content 非字符串", { content: 42 }],
      ["content 为空白字符串", { content: "   \n\t " }],
      ["arguments 非法 JSON", undefined],
    ])("%s 时返回 invalid_arguments", async (_label, args) => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      const call = args === undefined
        ? makeCall({}, WRITE_PLAN_TOOL_ID, "{not-json")
        : makeCall(args as Record<string, unknown>);

      const observation = await executeWritePlan(call, makeCtx());

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("invalid_arguments");
      expect(observation.message).toContain("content 必须是非空");
    });

    it("成功写入计划文件并发出 plan_written 事件", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      const events: { type: string; planPath?: string }[] = [];

      const observation = await executeWritePlan(
        makeCall({ content: `  ${PLAN_CONTENT}  ` }),
        makeCtx(),
        (event) => events.push(event as { type: string; planPath?: string }),
      );

      expect(observation.outcome).toBe("success");
      expect(observation.tool).toBe(WRITE_PLAN_TOOL_ID);
      expect(observation.target).toMatch(/\.cyrene\/docs\/plan-\d{8}-\d{6}\.md$/);
      expect(observation.message).toContain(observation.target!);
      // 写入的是 trim 后的内容
      expect(await readActivePlan("conv-1")).toBe(PLAN_CONTENT);
      // 事件携带真实落盘路径
      expect(events).toEqual([{ type: "plan_written", planPath: observation.target }]);
      // 标记本轮已写计划
      expect(hasPlanWrittenThisRun("conv-1")).toBe(true);
    });

    it("write_plan 不修改项目 .gitignore（是否忽略由用户决定）", async () => {
      const gitignorePath = path.join(workspaceRoot, ".gitignore");
      fs.writeFileSync(gitignorePath, "node_modules\n", "utf8");
      enterPlanDiscussing("conv-1", workspaceRoot);

      await executeWritePlan(makeCall({ content: PLAN_CONTENT }), makeCtx());
      await executeWritePlan(makeCall({ content: `${PLAN_CONTENT}\n\n补充一节。` }), makeCtx());

      // 覆盖写入后文件为最新内容
      expect(await readActivePlan("conv-1")).toContain("补充一节。");
      // Plan Mode 承诺不改项目：.gitignore 原样保留
      expect(fs.readFileSync(gitignorePath, "utf8")).toBe("node_modules\n");
    });

    it("无 workspaceRoot 时回落 userData 计划路径并落盘", async () => {
      const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tools-fb-"));
      try {
        initPlanPaths(fallbackRoot);
        enterPlanDiscussing("conv-fb");

        const observation = await executeWritePlan(
          makeCall({ content: PLAN_CONTENT }),
          { userQuery: "计划", conversationId: "conv-fb" },
        );

        const expected = `${fallbackRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/plans/conv-fb/plan.md`;
        expect(observation.outcome).toBe("success");
        expect(observation.target).toBe(expected);
        expect(fs.readFileSync(expected, "utf8")).toBe(PLAN_CONTENT);
        // userData 兜底路径不属于工作区，不应触碰 .gitignore
        expect(fs.existsSync(path.join(fallbackRoot, ".gitignore"))).toBe(false);
      } finally {
        fs.rmSync(fallbackRoot, { recursive: true, force: true });
      }
    });

    it("计划文件写入失败时返回 runtime_safety 且不标记已写", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      const realWrite = fs.promises.writeFile.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "writeFile");
      spy.mockImplementation(((...args: unknown[]) => {
        const target = String(args[0]);
        if (target.includes("plan-")) {
          return Promise.reject(new Error("EACCES: permission denied"));
        }
        return realWrite(...(args as Parameters<typeof fs.promises.writeFile>));
      }) as unknown as typeof fs.promises.writeFile);

      const events: unknown[] = [];
      const observation = await executeWritePlan(
        makeCall({ content: PLAN_CONTENT }),
        makeCtx(),
        (event) => events.push(event),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("计划文件写入失败");
      expect(observation.message).toContain("EACCES");
      expect(events).toEqual([]);
      expect(hasPlanWrittenThisRun("conv-1")).toBe(false);
    });
  });

  describe("buildPlanApprovalCard", () => {
    it("生成三档审批卡片（批准 / 需要修改 / 不批准）", () => {
      const card = buildPlanApprovalCard("E:/ws/.cyrene/docs/plan-20260915-120000.md");

      // 专属三按钮面板按 mode 识别
      expect(card.mode).toBe("plan_approval");
      expect(card.planPath).toBe("E:/ws/.cyrene/docs/plan-20260915-120000.md");
      // 审批等待独立计时：user-choice 靠该档位区分快问快答
      expect(card.waitTimeoutTone).toBe("plan_approval");
      expect(card.questions).toHaveLength(1);
      const question = card.questions[0]!;
      expect(question.field).toBe("plan_decision");
      expect(question.type).toBe("single_select");
      // "需要修改"档的意见随档位同卡回传（option_with_text），依赖 allowCustom 放行
      expect(question.allowCustom).toBe(true);
      expect(question.freeTextPlaceholder).not.toBe("");
      // 选项顺序是渲染端位置契约：第 1 个=批准、第 2 个=需要修改、第 3 个=不批准
      expect(question.options).toEqual([
        { label: "批准", value: "approve" },
        { label: "需要修改", value: "revise" },
        { label: "不批准", value: "reject" },
      ]);
      expect(card.deferredFields).toEqual([]);
    });
  });

  describe("executeSubmitPlan", () => {
    // 三档用例的公共前置：进入讨论态并把计划真实落盘（交卷前会读全文）
    async function setupSubmittedPlan(): Promise<void> {
      enterPlanDiscussing("conv-1", workspaceRoot);
      await executeWritePlan(makeCall({ content: PLAN_CONTENT }), makeCtx());
    }

    it("NORMAL 状态拒绝交卷", async () => {
      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        vi.fn(),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("submit_plan 仅在计划讨论状态可用");
    });

    it("PLAN_REVIEW 状态拒绝重复交卷", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      markPlanWritten("conv-1");
      moveToReview("conv-1");

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        vi.fn(),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.message).toContain("submit_plan 仅在计划讨论状态可用");
    });

    it("EXECUTING 状态拒绝交卷", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      markPlanWritten("conv-1");
      moveToReview("conv-1");
      approvePlan("conv-1");

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        vi.fn(),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.message).toContain("submit_plan 仅在计划讨论状态可用");
    });

    it("讨论态但本轮未写计划时拒绝", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        vi.fn(),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("本轮尚未 write_plan，请先写入计划再提交审批");
    });

    it("requestUserClarification 未注入时拒绝且不迁移状态", async () => {
      enterPlanDiscussing("conv-1", workspaceRoot);
      markPlanWritten("conv-1");

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        undefined,
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.message).toContain("requestUserClarification 函数未注入");
      // 注入校验在交卷之前：不应进入 REVIEW
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
    });

    it("批准：进入 EXECUTING，回执携带计划全文（同 run 原地开工）", async () => {
      await setupSubmittedPlan();
      const reviewSpy = vi.spyOn(toastEvents, "publishPlanReview");
      const approvedSpy = vi.spyOn(toastEvents, "publishPlanApproved");
      const events: { type: string; [key: string]: unknown }[] = [];
      const requestClarification = vi.fn(async () => {
        // 审批卡发布前 toast 必须已归类同 run（去重互斥依赖此顺序）
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        return {
          requestId: "req-1",
          answers: [{ field: "plan_decision", selectedValues: ["approve"] }],
        };
      });

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx({ runId: "run-1" }),
        requestClarification,
        (event) => events.push(event as { type: string; [key: string]: unknown }),
      );

      expect(observation.outcome).toBe("success");
      expect(observation.tool).toBe(SUBMIT_PLAN_TOOL_ID);
      expect(observation.message).toContain("用户已批准该计划，现在开始执行。");
      expect(observation.message).toContain(PLAN_CONTENT);
      expect(getPlanState("conv-1")).toBe("EXECUTING");
      expect(requestClarification).toHaveBeenCalledTimes(1);
      // 计划全文经 plan_submitted 独立事件下发（渲染端打开计划面板的依据）
      expect(events).toEqual([{
        type: "plan_submitted",
        conversationId: "conv-1",
        planPath: getPlanPath("conv-1"),
        planContent: PLAN_CONTENT,
      }]);
      expect(reviewSpy).toHaveBeenCalledWith({ sessionId: "conv-1", runId: "run-1" });
      expect(approvedSpy).toHaveBeenCalledWith({ sessionId: "conv-1", runId: "run-1" });
    });

    it("需要修改：意见随档位同卡回传，单卡结算回讨论态", async () => {
      await setupSubmittedPlan();
      const requestClarification = vi.fn(async () => ({
        requestId: "req-1",
        answers: [{ field: "plan_decision", selectedValues: ["revise"], customText: "第三步改成先写测试" }],
      }));

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        requestClarification,
      );

      expect(observation.outcome).toBe("success");
      expect(observation.message).toContain("用户要求先修改计划，再重新提交审批。");
      expect(observation.message).toContain("第三步改成先写测试");
      expect(observation.message).toContain("write_plan 整份覆盖");
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
      // 一张卡承载决定与意见，不再弹第二段纯文本卡
      expect(requestClarification).toHaveBeenCalledTimes(1);
    });

    it("需要修改但未带意见：防御兜底回讨论态并提示与用户确认", async () => {
      await setupSubmittedPlan();
      const requestClarification = vi.fn(async () => ({
        requestId: "req-1",
        answers: [{ field: "plan_decision", selectedValues: ["revise"] }],
      }));

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        requestClarification,
      );

      expect(observation.outcome).toBe("success");
      expect(observation.message).toContain("未填写具体意见，已回到计划讨论状态");
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
    });

    it("不批准：退出计划模式，计划文件保留", async () => {
      await setupSubmittedPlan();
      const requestClarification = vi.fn(async () => ({
        requestId: "req-1",
        answers: [{ field: "plan_decision", selectedValues: ["reject"] }],
      }));

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        requestClarification,
      );

      expect(observation.outcome).toBe("success");
      expect(observation.message).toContain("用户否决了该计划，已退出计划模式。");
      expect(getPlanState("conv-1")).toBe("NORMAL");
      // 三档均不删除计划文件（项目资产）
      expect(fs.existsSync(getPlanPath("conv-1"))).toBe(true);
    });

    it("等待超时/空答案：回讨论态，不默认批准也不默认否决", async () => {
      await setupSubmittedPlan();
      const endedSpy = vi.spyOn(toastEvents, "publishPlanReviewEnded");
      const requestClarification = vi.fn(async () => ({ requestId: "req-1", answers: [] }));

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        requestClarification,
      );

      expect(observation.outcome).toBe("success");
      expect(observation.message).toContain("等待审批超时，已回到计划讨论状态。");
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
      expect(fs.existsSync(getPlanPath("conv-1"))).toBe(true);
      expect(endedSpy).toHaveBeenCalled();
    });

    it("计划文件读取失败：拉回讨论态并返回 failure", async () => {
      await setupSubmittedPlan();
      fs.rmSync(getPlanPath("conv-1"));

      const observation = await executeSubmitPlan(
        makeCall({}, SUBMIT_PLAN_TOOL_ID),
        makeCtx(),
        vi.fn(),
      );

      expect(observation.outcome).toBe("failure");
      expect(observation.category).toBe("runtime_safety");
      expect(observation.message).toContain("计划文件读取失败，无法提交审批");
      // 读不到全文不能让用户盲批：交卷回滚为讨论态
      expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
    });
  });
});
