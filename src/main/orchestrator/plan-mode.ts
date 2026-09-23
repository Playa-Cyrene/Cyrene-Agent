/**
 * 计划模式状态机。
 *
 * 四状态：NORMAL / PLAN_DISCUSSING / PLAN_REVIEW / EXECUTING
 * - 会话级内存 Map + state.json 持久化（persister 由 main 注入，durable transition）；
 *   崩溃恢复只恢复事实不恢复执行权：非 NORMAL 快照统一降级 PLAN_DISCUSSING
 * - 本模块保持纯净（无 electron / fs 依赖），userData 兜底根由 initPlanPaths 注入
 * - 计划文件优先落工作区 `<workspaceRoot>/.cyrene/docs/plan-<时间戳>.md`
 *   （项目产物归项目；.cyrene 是否进 git 由用户自己决定，Plan Mode 不代劳改 .gitignore）；
 *   拿不到 workspaceRoot 时回落 userData/plans/<conversationId>/plan.md
 * - code 与 chat（开启工具走 harness）模式参与；work 预留接口（调用方按 conversationMode 决定是否进入）
 */

export type PlanStateName = "NORMAL" | "PLAN_DISCUSSING" | "PLAN_REVIEW" | "EXECUTING";

/** 崩溃恢复标记：记录会话由哪个非 NORMAL 状态降级而来，供 [PLAN_RECOVERY] 注入一次性消费。 */
export type PlanRecoveredFrom = "PLAN_REVIEW" | "EXECUTING";

/** state.json 的持久化形态（v1）。conversationId 存原始值，恢复时用它做会话键。 */
export interface PlanStateSnapshot {
  version: 1;
  conversationId: string;
  state: PlanStateName;
  planPath: string;
  enteredAt: number;
  updatedAt: number;
}

interface PlanSessionState {
  state: PlanStateName;
  /** 本轮 run 内是否发生过 write_plan（方案 Y：run 结束时消费） */
  planWrittenThisRun: boolean;
  /** 当前活动计划文件：进入计划讨论时生成；同一周期（讨论→补充→重写）覆盖同一文件 */
  planPath: string;
  enteredAt: number;
  /** 崩溃恢复标记：恢复注入 [PLAN_RECOVERY] 后清除（一次性消费） */
  recoveredFrom?: PlanRecoveredFrom;
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

/**
 * 状态持久化器（可选）：由 main 注入，所有状态转换必经点先落盘再广播。
 * 签名必须是同步 durable 写（如 fs.writeFileSync）：approvePlan 返回时 state.json 已在磁盘上，
 * 崩溃恢复不会丢掉"执行正在进行"的事实。snapshot 为 null 表示回 NORMAL，负责删除 state.json。
 * 传入 null 可禁用（测试用）。
 */
type PlanStatePersister = (conversationId: string, snapshot: PlanStateSnapshot | null) => void;
let statePersister: PlanStatePersister | null = null;

/** 注入状态持久化器；传入 null 可禁用（测试用）。 */
export function initPlanStatePersister(persister: PlanStatePersister | null): void {
  statePersister = persister;
}

function broadcastState(conversationId: string, state: PlanStateName): void {
  try {
    stateBroadcaster?.(conversationId, state);
  } catch {
    // 广播失败不影响状态机本身
  }
}

/**
 * 状态转换必经点：先持久化再广播，各自独立 try/catch，互不株连——
 * 落盘失败不影响状态机与广播，广播失败不影响落盘。回 NORMAL 时传 null 删 state.json 清尸。
 */
function publishTransition(conversationId: string, s: PlanSessionState): void {
  const snapshot: PlanStateSnapshot | null = s.state === "NORMAL"
    ? null
    : {
        version: 1,
        conversationId,
        state: s.state,
        planPath: s.planPath,
        enteredAt: s.enteredAt,
        updatedAt: Date.now(),
      };
  try {
    statePersister?.(conversationId, snapshot);
  } catch (err) {
    // 落盘失败只告警：状态机本身不受影响，下次转换会重写覆盖
    console.warn(`[PlanMode] state.json 持久化失败 conversation=${conversationId}:`, err);
  }
  broadcastState(conversationId, s.state);
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

/**
 * 会话目录名编码：conversationId 形态不受信任（可能来自外部），
 * 消除 / \ .. : 等路径字符风险后才能作为 plans/ 下的子目录名。
 */
export function encodePlanSessionKey(conversationId: string): string {
  const key = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return key || "default";
}

function fallbackPlanPath(conversationId: string): string {
  const root = plansRoot ?? "";
  const key = encodePlanSessionKey(conversationId);
  return root
    ? posixJoin(root, "plans", key, "plan.md")
    : posixJoin("plans", key, "plan.md");
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
  publishTransition(conversationId, s);
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
  publishTransition(conversationId, s);
  return true;
}

/** PLAN_REVIEW → PLAN_DISCUSSING（用户补充；或用户新消息把等待拉回讨论）。 */
export function supplementPlan(conversationId: string): boolean {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "PLAN_REVIEW") return false;
  s.state = "PLAN_DISCUSSING";
  publishTransition(conversationId, s);
  return true;
}

/** PLAN_REVIEW → EXECUTING（唯一合法触发：用户真实点击批准）。 */
export function approvePlan(conversationId: string): boolean {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "PLAN_REVIEW") return false;
  s.state = "EXECUTING";
  publishTransition(conversationId, s);
  return true;
}

/** 任意状态 → NORMAL（UI 直接退出 / 异常兜底）。 */
export function exitPlanMode(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (!s) return;
  s.state = "NORMAL";
  s.planWrittenThisRun = false;
  publishTransition(conversationId, s);
}

/** EXECUTING → NORMAL（执行 run 结束自动摘牌）；返回 planPath 供"施工已完成"标注。 */
export function completeExecution(conversationId: string): string | undefined {
  const s = sessions.get(conversationId);
  if (!s || s.state !== "EXECUTING") return undefined;
  s.state = "NORMAL";
  s.planWrittenThisRun = false;
  publishTransition(conversationId, s);
  return s.planPath;
}

/**
 * 启动崩溃恢复专用入口：校验快照后直接还原会话。
 * - 不走正常 transition 函数：恢复本身不产生新状态，不触发再次持久化
 * - 只恢复事实（计划路径 + 进入时间），不恢复执行许可：
 *   非 NORMAL 快照统一降级 PLAN_DISCUSSING；REVIEW/EXECUTING 来源打 recoveredFrom 标记，
 *   由 [PLAN_RECOVERY] 注入消费——crash recovery 先恢复事实，再让用户重新决策
 * - 只广播最终恢复态，让 UI 与内存一致
 */
export function restorePlanSession(
  conversationId: string,
  snapshot: unknown,
): { ok: boolean; reason?: string } {
  const snap = snapshot as Partial<PlanStateSnapshot> | null | undefined;
  if (!snap || typeof snap !== "object") return { ok: false, reason: "快照为空或非对象" };
  if (snap.version !== 1) return { ok: false, reason: `不支持的快照版本: ${String(snap.version)}` };
  // 快照里的原始 conversationId 必须与目录对应的会话键一致，防止错位恢复
  if (snap.conversationId !== conversationId) {
    return { ok: false, reason: `快照会话键不匹配: ${String(snap.conversationId)}` };
  }
  if (typeof snap.planPath !== "string") return { ok: false, reason: "快照缺少 planPath" };
  if (typeof snap.enteredAt !== "number") return { ok: false, reason: "快照缺少 enteredAt" };
  const before = snap.state;
  if (before !== "PLAN_DISCUSSING" && before !== "PLAN_REVIEW" && before !== "EXECUTING") {
    return { ok: false, reason: `不可恢复的状态: ${String(before)}` };
  }

  const s = ensureSession(conversationId);
  s.state = "PLAN_DISCUSSING";
  s.planWrittenThisRun = false;
  s.planPath = snap.planPath;
  s.enteredAt = snap.enteredAt;
  // 讨论态中断没有"执行过一半"的事实需要注入，不打标记
  s.recoveredFrom = before === "PLAN_DISCUSSING" ? undefined : before;
  broadcastState(conversationId, s.state);
  return { ok: true };
}

/** 读取崩溃恢复标记（REVIEW/EXECUTING 中断的证据），供 [PLAN_RECOVERY] 注入判断。 */
export function getPlanRecoveredFrom(conversationId: string): PlanRecoveredFrom | undefined {
  return sessions.get(conversationId)?.recoveredFrom;
}

/** 消费恢复标记：[PLAN_RECOVERY] 注入后清除，保证只注入一次（后续消息不重复）。 */
export function clearPlanRecoveredFrom(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (s) s.recoveredFrom = undefined;
}

/** 测试辅助：清空全部会话状态。 */
export function resetPlanSessionsForTest(): void {
  sessions.clear();
  plansRoot = null;
  stateBroadcaster = null;
  statePersister = null;
}
