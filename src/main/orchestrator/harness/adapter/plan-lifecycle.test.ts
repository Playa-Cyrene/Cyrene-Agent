import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  trace,
  getPlanState,
  supplementPlan,
  getPlanPath,
  completeExecution,
  getPlanRecoveredFrom,
  clearPlanRecoveredFrom,
  readFile,
} = vi.hoisted(() => ({
  trace: [] as string[],
  getPlanState: vi.fn(),
  supplementPlan: vi.fn(),
  getPlanPath: vi.fn(() => "C:\\plans\\plan.md"),
  completeExecution: vi.fn(),
  getPlanRecoveredFrom: vi.fn(),
  clearPlanRecoveredFrom: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../../plan-mode", () => ({
  getPlanState,
  supplementPlan,
  getPlanPath,
  completeExecution,
  getPlanRecoveredFrom,
  clearPlanRecoveredFrom,
}));

vi.mock("fs", () => ({
  promises: { readFile },
}));

import { completePlanRun, preparePlanRunContext } from "./plan-lifecycle";

describe("harness plan lifecycle", () => {
  beforeEach(() => {
    trace.length = 0;
    getPlanState.mockReset();
    supplementPlan.mockReset();
    getPlanPath.mockReset();
    getPlanPath.mockReturnValue("C:\\plans\\plan.md");
    completeExecution.mockReset();
    getPlanRecoveredFrom.mockReset();
    clearPlanRecoveredFrom.mockReset();
    readFile.mockReset();
  });

  it("returns the plan state after moving PLAN_REVIEW back to discussion", async () => {
    getPlanState.mockReturnValueOnce("PLAN_REVIEW").mockReturnValueOnce("PLAN_DISCUSSING");

    const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

    expect(supplementPlan).toHaveBeenCalledWith("thread-1");
    expect(prepared.planState).toBe("PLAN_DISCUSSING");
  });

  it("emits plan completion only when execution returns a path and signal is active", () => {
    completeExecution.mockImplementation(() => {
      trace.push("completeExecution");
      return "C:\\plans\\plan.md";
    });
    const sent: unknown[] = [];

    completePlanRun({
      mode: "code",
      threadId: "thread-1",
      runId: "run-1",
      runStatus: "completed",
      signal: new AbortController().signal,
      send: (event) => sent.push(event),
    });

    expect(trace).toEqual(["completeExecution"]);
    expect(sent).toEqual([expect.objectContaining({
      type: "CUSTOM",
      name: "cyrene.plan.completed",
      runId: "run-1",
      value: { planPath: "C:\\plans\\plan.md", runStatus: "completed" },
    })]);
  });

  describe("[PLAN_RECOVERY] 崩溃恢复注入（事实参考，非执行许可）", () => {
    beforeEach(() => {
      getPlanState.mockReturnValue("PLAN_DISCUSSING");
    });

    it("PLAN_REVIEW 中断：首条消息注入旧计划草稿全文", async () => {
      getPlanRecoveredFrom.mockReturnValue("PLAN_REVIEW");
      readFile.mockResolvedValue("# 旧计划\n- [ ] 第一步");

      const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

      expect(prepared.planState).toBe("PLAN_DISCUSSING");
      expect(prepared.planContextBlock).toContain("[PLAN_RECOVERY]");
      expect(prepared.planContextBlock).toContain("等待审批时被中断");
      expect(prepared.planContextBlock).toContain("# 旧计划");
      // 注入前先消费标记，保证一次性
      expect(clearPlanRecoveredFrom).toHaveBeenCalledWith("thread-1");
    });

    it("EXECUTING 中断：注入「不要假设未执行」警示与计划全文", async () => {
      getPlanRecoveredFrom.mockReturnValue("EXECUTING");
      readFile.mockResolvedValue("# 旧计划\n- [ ] 已执行到一半的步骤");

      const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

      expect(prepared.planContextBlock).toContain("[PLAN_RECOVERY]");
      expect(prepared.planContextBlock).toContain("不要假设计划尚未执行");
      expect(prepared.planContextBlock).toContain("已执行到一半的步骤");
      expect(prepared.planContextBlock).toContain("不要直接继续执行");
    });

    it("无恢复标记的普通 DISCUSSING：不注入任何块", async () => {
      getPlanRecoveredFrom.mockReturnValue(undefined);

      const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

      expect(prepared.planContextBlock).toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
    });

    it("标记已消费（第二条消息）：不再注入", async () => {
      // 模拟 marker 已在首条消息消费：getPlanRecoveredFrom 返回 undefined
      getPlanRecoveredFrom.mockReturnValue(undefined);

      const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

      expect(prepared.planContextBlock).toBeUndefined();
    });

    it("计划文件已不存在：不 crash，不注入全文，仍注入中断警示", async () => {
      getPlanRecoveredFrom.mockReturnValue("EXECUTING");
      readFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const prepared = await preparePlanRunContext({ mode: "code", threadId: "thread-1" });

      expect(prepared.planContextBlock).toContain("[PLAN_RECOVERY]");
      expect(prepared.planContextBlock).toContain("不要假设计划尚未执行");
      // 全文缺失时不应出现"以下为中断前的计划原文"引导
      expect(prepared.planContextBlock).not.toContain("以下为中断前的计划原文");
    });
  });
});
