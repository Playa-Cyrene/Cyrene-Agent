// 对话级模型切换的竞态防护两件套（方案决策 10/11，阶段③）：
//
// - renderer barrier：切模型/切档案与"立即发送"的因果序。窄 IPC 不保证
//   SET 与 SEND 两个 handler 的执行顺序，发送入口 await barrier() 即可
//   保证 SEND 发生在模型变更提交之后（不赌 Electron handler 顺序，#21）。
// - operation token：最新一次切换独占 UI 更新权。每次切换递增 generation，
//   迟到的成功/失败回调若 token 不匹配则丢弃——防"B pending → C success →
//   B 迟到失败把正确的 C 打回 A"（#20）。
//
// 持久化提交顺序由主进程 per-session mutation queue 兜底（Invariant D，
// 阶段①已实现），本模块只管渲染端的因果序与 UI 回调顺序。
//
// 非乐观更新：UI 一律等 IPC 返回的 session 才刷新（onSessionUpdated），
// 失败不回调——"IPC 失败不假装成功"（#11）由该规则直接成立。

/** 切换器依赖的窄 IPC 形状（与 ChatStoreApi 的两个写方法对齐）。 */
export interface SessionModelSwitcherIpc<TSession> {
  setModelProfile: (sessionId: string, modelProfileId: string) => Promise<TSession | null>;
  setSessionModel: (
    sessionId: string,
    model: string,
  ) => Promise<{ ok: true; session: TSession } | { ok: false; error: string }>;
}

export interface SessionModelSwitcherCallbacks<TSession> {
  ipc: SessionModelSwitcherIpc<TSession>;
  /** 切换成功后的 UI 刷新（token 匹配的最新操作才触发）。 */
  onSessionUpdated: (session: TSession) => void;
}

export interface SessionModelSwitcher {
  /** 切档案（原子重置会话模型，主进程语义）。 */
  switchProfile: (sessionId: string, modelProfileId: string) => void;
  /** 切会话级模型（窄 IPC；stale binding 由主进程原子修复）。 */
  switchModel: (sessionId: string, model: string) => void;
  /** 发送前的屏障：等待最近一次未完成的模型状态变更提交完成。 */
  barrier: () => Promise<void>;
}

export function createSessionModelSwitcher<TSession>(
  callbacks: SessionModelSwitcherCallbacks<TSession>,
): SessionModelSwitcher {
  // 切档案与切模型共享同一个 generation：两者都是"会话模型状态切换"，
  // 互相的迟到回调都不得覆盖对方
  let generation = 0;
  let pending: Promise<void> | null = null;
  // 任务票据：只有"最后提交的那笔"才有权清空 pending（避免闭包自引用的 TDZ）
  let ticketSeq = 0;

  const run = (opId: number, task: () => Promise<TSession | null>): void => {
    const ticket = ++ticketSeq;
    pending = (async () => {
      try {
        const session = await task();
        // 只有最新操作能动 UI；失败（null / ok:false）不回调，不假装成功
        if (opId === generation && session) callbacks.onSessionUpdated(session);
      } catch {
        // IPC 异常同失败处理：不回调 UI，也不把异常抛给 barrier 的发送方
      } finally {
        // 队尾自动清理：旧任务的 finally 不误清后来者设置的 pending
        if (ticket === ticketSeq) pending = null;
      }
    })();
  };

  return {
    switchProfile(sessionId, modelProfileId) {
      const opId = ++generation;
      run(opId, () => callbacks.ipc.setModelProfile(sessionId, modelProfileId));
    },
    switchModel(sessionId, model) {
      const opId = ++generation;
      run(opId, async () => {
        const result = await callbacks.ipc.setSessionModel(sessionId, model);
        return result.ok ? result.session : null;
      });
    },
    async barrier() {
      await pending;
    },
  };
}
