/**
 * 计划模式状态机。
 *
 * 四状态：NORMAL / PLAN_DISCUSSING / PLAN_REVIEW / EXECUTING
 * - 会话级内存 Map，v1 不持久化（重启回 NORMAL，计划文件仍在磁盘）
 * - 本模块保持纯净（无 electron / fs 依赖），userData 兜底根由 initPlanPaths 注入
 * - 计划文件优先落工作区 `<workspaceRoot>/.cyrene/docs/plan-<时间戳>.md`
 *   （项目产物归项目；.cyrene 是否进 git 由用户自己决定，Plan Mode 不代劳改 .gitignore）；
 *   拿不到 workspaceRoot 时回落 userData/plans/<conversationId>/plan.md
 * - code 与 chat（开启工具走 harness）模式参与；work 预留接口（调用方按 conversationMode 决定是否进入）
 */

export type PlanStateName = "NORMAL" | "PLAN_DISCUSSING" | "PLAN_REVIEW" | "EXECUTING";

interface PlanSessionState {
  state: PlanStateName;
  /** 本轮 run 内是否发生过 write_plan（方案 Y：run 结束时消费） */
  planWrittenThisRun: boolean;
  /** 当前活动计划文件：进入计划讨论时生成；同一周期（讨论→补充→重写）覆盖同一文件 */
  planPath: string;
  enteredAt: number;
}

const sessions = new Map<string, PlanSessionState>();

/** userData 兜底根（无工作区时的回落路径），由主进程启动时注入。 */
let plansRoot: string | null = null;

/**
 * 状态广播器（可选）：由 main 进程注入，所有状态切换函数都会调用它。
 * 用途：让 UI（PermissionControl 等）能感知任何入口触发的状态变化——
 * 不只是模型 enter_plan_mode 路径，用户权限档位触发的也一样广播。
 */
type PlanStateBroadcaster = (conversationId: string, state: PlanStateName) => void;
let stateBroadcaster: PlanStateBroadcaster | null = null;

/** 由主进程启动时注入 userData 根路径。 */
export function initPlanPaths(userDataRoot: string): void {
  plansRoot = userDataRoot;
}

/** 注入状态广播器；传入 null 可禁用（测试用）。 */
export function initPlanStateBroadcaster(broadcaster: PlanStateBroadcaster | null): void {
  stateBroadcaster = broadcaster;
}

function broadcastState(conversationId: string, state: PlanStateName): void {
  try {
    stateBroadcaster?.(conversationId, state);
  } catch {
    // 广播失败不影响状态机本身
  }
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** 生成时间戳文件名：plan-20260817-153045.md（秒级，可读、可排序）。 */
function planFileName(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = [
    at.getFullYear(), pad(at.getMonth() + 1), pad(at.getDate()),
  ].join("") + "-" + [
    pad(at.getHours()), pad(at.getMinutes()), pad(at.getSeconds()),
  ].join("");
  return `plan-${stamp}.md`;
}

/** 工作区下的计划路径：<workspaceRoot>/.cyrene/docs/plan-<时间戳>.md */
export function buildWorkspacePlanPath(workspaceRoot: string): string {
  return posixJoin(workspaceRoot.replace(/[\\/]$/, ""), ".cyrene/docs", planFileName());
}

function fallbackPlanPath(conversationId: string): string {
  const root = plansRoot ?? "";
  return root
    ? posixJoin(root, "plans", conversationId, "plan.md")
    : posixJoin("plans", conversationId, "plan.md");
}

/** 当前活动计划文件路径（审批 / PLAN_CONTEXT 注入 / 完成标注共用）。 */
export function getPlanPath(conversationId: string): string {
  return sessions.get(conversationId)?.planPath || fallbackPlanPath(conversationId);
}

export function getPlanState(conversationId: string): PlanStateName {
  return sessions.get(conversationId)?.state ?? "NORMAL";
}

export function isInPlanDiscussion(conversationId: string): boolean {
  const s = getPlanState(conversationId);
  return s === "PLAN_DISCUSSING" || s === "PLAN_REVIEW";
}

/** PLAN_DISCUSSING/PLAN_REVIEW 期间强制只读。权限层与 Harness 运行时各拦一次（双入口），本函数供权限层调用。 */
export function isPlanReadOnly(conversationId: string): boolean {
  return isInPlanDiscussion(conversationId);
}

function ensureSession(conversationId: string): PlanSessionState {
  let s = sessions.get(conversationId);
  if (!s) {
    s = { state: "NORMAL", planWrittenThisRun: false, planPath: "", enteredAt: Date.now() };
    sessions.set(conversationId, s);
  }
  return s;
}

/** NORMAL → PLAN_DISCUSSING（幂等防御：仅 NORMAL 可进）。
 *  workspaceRoot 来自 ToolContext（Conversation Workspace Binding，唯一可信来源）；
 *  每次进入生成新的 plan-<时间戳>.md，多轮计划互不覆盖。 */
export function enterPlanDiscussing(
  conversationId: string,
  workspaceRoot?: string,
): { ok: boolean; reason?: string } {
  const s = ensureSession(conversationId);
  if (s.state === "PLAN_DISCUSSING") return { ok: false, reason: "已在计划模式中" };
  if (s.state === "PLAN_REVIEW") return { ok: false, reason: "计划待审批，等待用户决定" };
  if (s.state === "EXECUTING") return { ok: false, reason: "计划执行中，不可进入计划模式" };
  s.state = "PLAN_DISCUSSING";
  s.planWrittenThisRun = false;
  s.planPath = workspaceRoot
    ? buildWorkspacePlanPath(workspaceRoot)
    : fallbackPlanPath(conversationId);
  s.enteredAt = Date.now();
  broadcastState(conversationId, s.state);
  return { ok: true };
}

/** write_plan 成功后标记；run 结束时由 moveToReview 消费。 */
export function markPlanWritten(conversationId: string): void {
  const s = ensureSession(conversationId);
  s.planWrittenThisRun = true;
}

export function hasPlanWrittenThisRun(conversationId: string): boolean {
  return sessions.get(conversationId)?.planWrittenThisRun ?? false;
}

/** PLAN_DISCUSSING + 本轮 write_plan → PLAN_REVIEW（方案 Y：run 结束触发）。 */
export function moveToReview(conversationId: string): boolean {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "PLAN_DISCUSSING" || !s.planWrittenThisRun) return false;
  s.state = "PLAN_REVIEW";
  s.planWrittenThisRun = false;
  broadcastState(conversationId, s.state);
  return true;
}

/** PLAN_REVIEW → PLAN_DISCUSSING（用户补充；或用户新消息把等待拉回讨论）。 */
export function supplementPlan(conversationId: string): boolean {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "PLAN_REVIEW") return false;
  s.state = "PLAN_DISCUSSING";
  broadcastState(conversationId, s.state);
  return true;
}

/** PLAN_REVIEW → EXECUTING（唯一合法触发：用户真实点击批准）。 */
export function approvePlan(conversationId: string): boolean {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "PLAN_REVIEW") return false;
  s.state = "EXECUTING";
  broadcastState(conversationId, s.state);
  return true;
}

/** 任意状态 → NORMAL（UI 直接退出 / 异常兜底）。 */
export function exitPlanMode(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (!s) return;
  s.state = "NORMAL";
  s.planWrittenThisRun = false;
  broadcastState(conversationId, s.state);
}

/** EXECUTING → NORMAL（执行 run 结束自动摘牌）；返回 planPath 供"施工已完成"标注。 */
export function completeExecution(conversationId: string): string | undefined {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "EXECUTING") return undefined;
  s.state = "NORMAL";
  s.planWrittenThisRun = false;
  broadcastState(conversationId, s.state);
  return s.planPath;
}

/** 测试辅助：清空全部会话状态。 */
export function resetPlanSessionsForTest(): void {
  sessions.clear();
  plansRoot = null;
  stateBroadcaster = null;
}
