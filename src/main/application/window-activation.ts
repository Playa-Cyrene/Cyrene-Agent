/**
 * 窗口激活闸门（WindowActivationBroker）：
 * 启动完成前，窗口激活请求先排队合并（同 kind 只保留最新一条），
 * 并对每个请求回调 focusLoading 提示加载中；markReady 一次性放行积压请求。
 * stop() 之后清空队列并忽略后续请求（退出路径用）。
 * 注意：桌宠不接收通用主窗口激活请求，其可见性由 settings/toggle 路径管理。
 */

export type WindowActivationRequest =
  | { kind: "chat"; sessionId?: string }
  | { kind: "settings"; section?: string }
  | { kind: "music" };

export interface WindowActivationActions {
  /** 激活被延迟到启动完成时，向用户提示“加载中”。 */
  focusLoading(): void;
  activate(request: WindowActivationRequest): void | Promise<void>;
}

export interface WindowActivationBroker {
  /** 供应实际激活动作；bind 本身不代表就绪。 */
  bind(actions: WindowActivationActions): void;
  request(request: WindowActivationRequest): void;
  markReady(): Promise<void>;
  stop(): void;
  isReady(): boolean;
}

export function createWindowActivationBroker(): WindowActivationBroker {
  let actions: WindowActivationActions | null = null;
  const pending = new Map<WindowActivationRequest["kind"], WindowActivationRequest>();
  let ready = false;
  let stopped = false;

  // 激活失败不外抛：闸门只负责转发，错误兜底由动作实现方负责。
  function dispatch(request: WindowActivationRequest): void {
    const current = actions;
    if (!current) return;
    void Promise.resolve()
      .then(() => current.activate(request))
      .catch(() => { /* 激活失败不影响启动门状态 */ });
  }

  return {
    bind(next) {
      actions = next;
    },

    request(request) {
      if (stopped) return;
      if (ready) {
        dispatch(request);
        return;
      }
      actions?.focusLoading();
      pending.set(request.kind, request);
    },

    markReady() {
      if (ready || stopped) return Promise.resolve();
      ready = true;

      const queued = [...pending.values()];
      pending.clear();
      // 顺序放行，保证请求间的前后语义；单个激活失败不阻塞后续。
      let chain: Promise<void> = Promise.resolve();
      for (const request of queued) {
        chain = chain.then(() => {
          const current = actions;
          if (!current) return;
          return Promise.resolve(current.activate(request)).catch(() => { /* 同 dispatch */ });
        });
      }
      return chain.then(() => undefined);
    },

    stop() {
      stopped = true;
      pending.clear();
    },

    isReady: () => ready,
  };
}
