import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../vendors/types";
import type { ToolContext } from "../tools/registry/tool-context";
import {
  ENTER_PLAN_MODE_TOOL_ID,
  WRITE_PLAN_TOOL_ID,
  buildPlanReviewCard,
  buildPlanSupplementCard,
  executeEnterPlanMode,
  executeWritePlan,
} from "./plan-tools";
import {
  approvePlan,
  enterPlanDiscussing,
  getPlanState,
  hasPlanWrittenThisRun,
  initPlanPaths,
  markPlanWritten,
  moveToReview,
  resetPlanSessionsForTest,
} from "../plan-mode";

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

    it("自动把 .cyrene/ 加入 .gitignore（保留原有内容且幂等）", async () => {
      fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), "node_modules\n", "utf8");
      enterPlanDiscussing("conv-1", workspaceRoot);

      await executeWritePlan(makeCall({ content: PLAN_CONTENT }), makeCtx());
      await executeWritePlan(makeCall({ content: `${PLAN_CONTENT}\n\n补充一节。` }), makeCtx());

      const gitignore = fs.readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8");
      expect(gitignore).toContain("node_modules");
      expect(gitignore).toContain("# Cyrene agent");
      expect(gitignore.match(/\.cyrene\//g)).toHaveLength(1);
      // 覆盖写入后文件为最新内容
      expect(await readActivePlan("conv-1")).toContain("补充一节。");
    });

    it(".gitignore 已包含 .cyrene/ 时不重复追加", async () => {
      fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), "node_modules\n.cyrene/\n", "utf8");
      enterPlanDiscussing("conv-1", workspaceRoot);

      const observation = await executeWritePlan(makeCall({ content: PLAN_CONTENT }), makeCtx());

      expect(observation.outcome).toBe("success");
      const gitignore = fs.readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8");
      expect(gitignore.match(/\.cyrene\//g)).toHaveLength(1);
      expect(gitignore).not.toContain("# Cyrene agent");
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

  describe("buildPlanReviewCard", () => {
    it("生成两选项审批卡片并携带 planPath", () => {
      const card = buildPlanReviewCard("E:/ws/.cyrene/docs/plan-20260915-120000.md");

      expect(card.mode).toBe("semantic_clarification");
      expect(card.planPath).toBe("E:/ws/.cyrene/docs/plan-20260915-120000.md");
      expect(card.questions).toHaveLength(1);
      const question = card.questions[0]!;
      expect(question.field).toBe("plan_decision");
      expect(question.type).toBe("single_select");
      expect(question.allowCustom).toBe(false);
      expect(question.options).toEqual([
        { label: "批准计划，开始执行", value: "approve" },
        { label: "我要修改 / 补充", value: "supplement" },
      ]);
      expect(card.deferredFields).toEqual([]);
    });
  });

  describe("buildPlanSupplementCard", () => {
    it("生成纯文本补充卡片", () => {
      const card = buildPlanSupplementCard();

      expect(card.mode).toBe("semantic_clarification");
      expect(card.questions).toHaveLength(1);
      const question = card.questions[0]!;
      expect(question.field).toBe("plan_supplement");
      expect(question.type).toBe("text");
      expect(question.allowCustom).toBe(true);
      expect(question.options).toEqual([]);
      expect(question.freeTextPlaceholder).not.toBe("");
      expect(card.deferredFields).toEqual([]);
    });
  });
});
