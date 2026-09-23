// 计划模式状态机：持久化与崩溃恢复测试。
// durable 语义验证：同步 persister 下，状态转换函数返回时快照已"落盘"；
// 崩溃恢复只恢复事实不恢复执行权——非 NORMAL 快照统一降级 PLAN_DISCUSSING。

import { beforeEach, describe, expect, it } from "vitest";
import {
  approvePlan,
  clearPlanRecoveredFrom,
  completeExecution,
  encodePlanSessionKey,
  enterPlanDiscussing,
  exitPlanMode,
  getPlanPath,
  getPlanRecoveredFrom,
  getPlanState,
  initPlanStatePersister,
  isPlanReadOnly,
  markPlanWritten,
  moveToReview,
  resetPlanSessionsForTest,
  restorePlanSession,
  type PlanStateSnapshot,
} from "./plan-mode";

function makeSnapshot(overrides: Partial<PlanStateSnapshot> = {}): PlanStateSnapshot {
  return {
    version: 1,
    conversationId: "conv-r",
    state: "PLAN_REVIEW",
    planPath: "E:/ws/.cyrene/docs/plan-20260923-120000.md",
    enteredAt: 1780000000000,
    updatedAt: 1780000001000,
    ...overrides,
  };
}

describe("plan-mode 持久化（durable transition）", () => {
  let persisted: Map<string, PlanStateSnapshot | null>;

  beforeEach(() => {
    resetPlanSessionsForTest();
    persisted = new Map();
    initPlanStatePersister((conversationId, snapshot) => {
      // 同步实现：与 main 的 fs.writeFileSync 同语义，函数返回即已持久化
      persisted.set(conversationId, snapshot);
    });
  });

  it("enterPlanDiscussing 返回时快照已持久化（durable，非 fire-and-forget）", () => {
    expect(enterPlanDiscussing("conv-1")).toEqual({ ok: true });
    const snap = persisted.get("conv-1");
    expect(snap).toBeDefined();
    expect(snap!.version).toBe(1);
    expect(snap!.conversationId).toBe("conv-1");
    expect(snap!.state).toBe("PLAN_DISCUSSING");
    expect(typeof snap!.updatedAt).toBe("number");
  });

  it("approvePlan 返回时磁盘已是 EXECUTING——崩溃后能从快照恢复事实", () => {
    enterPlanDiscussing("conv-1");
    markPlanWritten("conv-1");
    moveToReview("conv-1");
    expect(approvePlan("conv-1")).toBe(true);
    // 此刻若进程崩溃，state.json 记录的是 EXECUTING，不会丢失"执行正在进行"的事实
    expect(persisted.get("conv-1")?.state).toBe("EXECUTING");
  });

  it("exitPlanMode / completeExecution 回 NORMAL 时传 null 删除 state.json（清尸）", () => {
    enterPlanDiscussing("conv-1");
    markPlanWritten("conv-1");
    moveToReview("conv-1");
    approvePlan("conv-1");
    completeExecution("conv-1");
    expect(persisted.get("conv-1")).toBeNull();

    enterPlanDiscussing("conv-2");
    exitPlanMode("conv-2");
    expect(persisted.get("conv-2")).toBeNull();
  });

  it("persister 抛错不阻塞状态机与广播（独立 try/catch）", () => {
    initPlanStatePersister(() => {
      throw new Error("EACCES: disk full");
    });
    expect(enterPlanDiscussing("conv-1")).toEqual({ ok: true });
    expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
    // 后续转换照常工作（下次转换会重写覆盖）
    expect(markPlanWritten("conv-1")).toBeUndefined();
    expect(moveToReview("conv-1")).toBe(true);
    expect(getPlanState("conv-1")).toBe("PLAN_REVIEW");
  });

  it("未注入 persister 时状态机正常工作（向后兼容）", () => {
    initPlanStatePersister(null);
    expect(enterPlanDiscussing("conv-1")).toEqual({ ok: true });
    expect(getPlanState("conv-1")).toBe("PLAN_DISCUSSING");
  });
});

describe("plan-mode 崩溃恢复（只恢复事实，不恢复执行权）", () => {
  let persistCalls: Array<PlanStateSnapshot | null>;

  beforeEach(() => {
    resetPlanSessionsForTest();
    persistCalls = [];
    initPlanStatePersister((_conversationId, snapshot) => {
      persistCalls.push(snapshot);
    });
  });

  it.each(["PLAN_REVIEW", "EXECUTING"] as const)(
    "%s 快照恢复为 PLAN_DISCUSSING 并打 recoveredFrom 标记",
    (before) => {
      const result = restorePlanSession("conv-r", makeSnapshot({ state: before }));
      expect(result.ok).toBe(true);
      expect(getPlanState("conv-r")).toBe("PLAN_DISCUSSING");
      expect(isPlanReadOnly("conv-r")).toBe(true);
      expect(getPlanRecoveredFrom("conv-r")).toBe(before);
    },
  );

  it("PLAN_DISCUSSING 快照恢复后不打标记（无中断事实需要注入）", () => {
    const result = restorePlanSession("conv-r", makeSnapshot({ state: "PLAN_DISCUSSING" }));
    expect(result.ok).toBe(true);
    expect(getPlanState("conv-r")).toBe("PLAN_DISCUSSING");
    expect(getPlanRecoveredFrom("conv-r")).toBeUndefined();
  });

  it("恢复不走正常 transition：不触发再次持久化", () => {
    restorePlanSession("conv-r", makeSnapshot({ state: "EXECUTING" }));
    expect(persistCalls).toEqual([]);
  });

  it("恢复保留原计划路径与进入时间（事实还原）", () => {
    const snapshot = makeSnapshot({ planPath: "E:/ws/.cyrene/docs/plan-old.md", enteredAt: 1770000000000 });
    restorePlanSession("conv-r", snapshot);
    expect(getPlanPath("conv-r")).toBe("E:/ws/.cyrene/docs/plan-old.md");
  });

  it("clearPlanRecoveredFrom 消费标记（保证 [PLAN_RECOVERY] 只注入一次）", () => {
    restorePlanSession("conv-r", makeSnapshot({ state: "EXECUTING" }));
    clearPlanRecoveredFrom("conv-r");
    expect(getPlanRecoveredFrom("conv-r")).toBeUndefined();
  });

  it.each([
    ["版本不支持", { ...makeSnapshot(), version: 2 }],
    ["会话键不匹配", { ...makeSnapshot(), conversationId: "other-conv" }],
    ["缺少 planPath", { ...makeSnapshot(), planPath: undefined }],
    ["缺少 enteredAt", { ...makeSnapshot(), enteredAt: undefined }],
    ["不可恢复的状态", { ...makeSnapshot(), state: "NORMAL" }],
    ["非对象", "not-a-snapshot"],
  ])("非法快照（%s）拒绝恢复且不产生会话", (_label, snapshot) => {
    const result = restorePlanSession("conv-r", snapshot);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(getPlanState("conv-r")).toBe("NORMAL");
    expect(persistCalls).toEqual([]);
  });

  it("恢复后再走正常转换：write_plan → REVIEW 正常持久化新状态", () => {
    restorePlanSession("conv-r", makeSnapshot({ state: "EXECUTING" }));
    markPlanWritten("conv-r");
    moveToReview("conv-r");
    expect(getPlanState("conv-r")).toBe("PLAN_REVIEW");
    expect(persistCalls[0]?.state).toBe("PLAN_REVIEW");
  });
});

describe("encodePlanSessionKey（会话目录名编码）", () => {
  it("消除路径字符风险", () => {
    expect(encodePlanSessionKey("a/b\\c..d:e")).toBe("a_b_c__d_e");
    expect(encodePlanSessionKey("../escape")).toBe("___escape");
    expect(encodePlanSessionKey("conv-123")).toBe("conv-123");
  });

  it("空值回落 default", () => {
    expect(encodePlanSessionKey("")).toBe("default");
  });
});
