/**
 * 独占语音输入租约服务：主进程全局同一时刻只允许一个插件持有租约。
 *
 * 设计要点（与实现计划阶段 5/6 对齐）：
 * - acquire() 在一次同步临界区内完成"检查占用 → 冻结目标 → 登记插件资源"，
 *   中途不让出事件循环，避免两个插件同时拿到租约；
 * - 目标冻结自活动聊天目标登记表：页面内切换会话不迁移、不终止已取得的
 *   租约；页面重载/导航/销毁或冻结会话被删除时租约自动中止（signal 触发）；
 * - active-call 目标冻结通话代次：取得租约时接管通话输入（停止内置 ASR），
 *   通话结束立即中止租约；代次单调递增，旧租约不可能提交到下一次通话；
 * - commit() 只校验租约本身、冻结目标是否仍有效、非空文本和插件状态；
 *   同一租约的多次 commit 串行执行；
 * - release() 幂等；插件停用、激活回滚（资源跟踪器清理）、目标失效和
 *   应用退出都收敛到同一条释放路径。
 */
import { randomUUID } from "node:crypto";
import type {
  PluginSpeechInputAcquireOptions,
  PluginSpeechInputLease,
  PluginSpeechInputService,
} from "../../plugins/api";
import type { PluginResourceTracker } from "../../plugins/resources";
import { pluginHostError } from "./errors";
import type { ActiveChatTarget, ActiveChatTargetRegistry } from "./active-chat-target";

/** 租约冻结的提交目标：取得租约时从登记表拷贝，后续切换会话不影响该值。 */
export type FrozenSpeechInputTarget = ActiveChatTarget;

/**
 * 租约内部冻结的输入目标：普通聊天冻结渲染目标，活动通话冻结通话代次。
 * 通话代次与渲染目标无关；通话结束后代次永不复用，提交自然被拒。
 */
export type FrozenSpeechInputLeaseTarget =
  | { kind: "active-chat"; chat: FrozenSpeechInputTarget }
  | { kind: "active-call"; callGeneration: number };

/**
 * 活动通话输入控制器：语音租约选择 active-call 目标时由宿主接线。
 * 实现方（通话管理器适配器）负责把结果映射为稳定错误码后抛出。
 */
export interface SpeechInputCallController {
  /**
   * 接管通话输入：无活动通话返回 null；成功则停止内置 ASR 并返回冻结的通话代次。
   * 必须同步完成所有权标记，避免接管与音频帧转发交错。
   */
  claimExternalInput(): { callGeneration: number } | null;
  /**
   * 提交外部文本到冻结代次的通话；接受即返回，不等待轮次结束。
   * 通话结束、代次过期、轮次进行中或输入未被接管时抛稳定错误码异常。
   */
  commitExternalText(callGeneration: number, text: string): void;
  /** 释放外部输入所有权：同一通话仍有效时归还内置 ASR；其余情况静默 no-op。 */
  releaseExternalInput(callGeneration: number): void;
  /** 通话结束通知：冻结该通话代次的租约据此立即中止。 */
  onCallEnded(listener: (callGeneration: number) => void): () => void;
}

/**
 * 文本提交桥：把冻结目标与最终文本送入聊天渲染页。
 * 真实实现（IPC 提交桥）在阶段 5 大步 3 接入；主进程侧据此忽略
 * 旧页面或错误目标的迟到响应。
 */
export interface SpeechInputCommitBridge {
  /** 用户消息被接受并落盘后 resolve；目标失效或会话删除时以稳定错误码 reject。 */
  commit(target: FrozenSpeechInputTarget, text: string): Promise<void>;
}

/** 会话存储的最小只读视图；真实实现是 chats-store，测试注入内存假件。 */
export interface SpeechInputSessionStore {
  /** 返回会话对象表示存在；null/undefined 表示已删除。 */
  getSession(sessionId: string): (unknown) | Promise<unknown>;
}

/** 租约持有者的插件上下文（由宿主服务工厂传入）。 */
export interface SpeechInputLeaseOwner {
  pluginId: string;
  /** 插件停止信号；停止后 acquire/commit 返回 E_PLUGIN_STOPPING。 */
  signal: AbortSignal;
  /** 插件资源跟踪器：租约登记进去，插件停止/激活回滚时统一释放。 */
  tracker: PluginResourceTracker;
}

export interface SpeechInputServiceOptions {
  registry: ActiveChatTargetRegistry;
  sessionStore: SpeechInputSessionStore;
  commitBridge: SpeechInputCommitBridge;
  /** 活动通话输入控制器：active-call 目标的接管、提交与释放经它落到通话管理器。 */
  callController: SpeechInputCallController;
}

export interface SpeechInputService {
  /** 每插件入口：宿主服务工厂调用，把插件上下文与全局租约关联。 */
  acquireForPlugin(
    owner: SpeechInputLeaseOwner,
    options: PluginSpeechInputAcquireOptions,
  ): Promise<PluginSpeechInputLease>;
  /** 释放全部租约并退订登记表监听（应用退出时调用）。 */
  dispose(): void;
}

interface LeaseState {
  /** 资源跟踪器内的登记键（kind 为 speech-input-lease）。 */
  key: string;
  pluginId: string;
  ownerSignal: AbortSignal;
  frozen: FrozenSpeechInputLeaseTarget;
  controller: AbortController;
  released: boolean;
  /** 同一租约多次 commit 的串行队列；前一次失败不阻断后续。 */
  queue: Promise<unknown>;
  /** 租约释放时需要摘除的全部退订函数。 */
  unsubscribe: Array<() => void>;
}

export function createSpeechInputService(options: SpeechInputServiceOptions): SpeechInputService {
  const { registry, sessionStore, commitBridge, callController } = options;
  let current: LeaseState | null = null;
  let disposed = false;

  /** 唯一释放路径：幂等，摘监听、中止信号、腾出全局占用。 */
  function releaseLease(state: LeaseState): void {
    if (state.released) return;
    state.released = true;
    for (const off of state.unsubscribe.splice(0)) {
      try {
        off();
      } catch (error) {
        console.warn(`[speech-input] 退订监听失败（插件 ${state.pluginId}）`, error);
      }
    }
    // 活动通话目标：释放时归还内置 ASR（通话已结束则控制器内部 no-op）
    if (state.frozen.kind === "active-call") {
      try {
        callController.releaseExternalInput(state.frozen.callGeneration);
      } catch (error) {
        console.warn(`[speech-input] 归还通话输入失败（插件 ${state.pluginId}）`, error);
      }
    }
    if (!state.controller.signal.aborted) {
      state.controller.abort();
    }
    if (current === state) {
      current = null;
    }
  }

  // 渲染目标失效（页面重载/导航/销毁）：冻结目标与失效目标同源即中止租约。
  // 同页面切换会话不会触发失效（rendererTargetId 不变），租约不受影响。
  const offInvalidated = registry.onInvalidated((_reason, affected) => {
    if (!current || !affected) return;
    if (current.frozen.kind === "active-chat"
      && current.frozen.chat.rendererTargetId === affected.rendererTargetId) {
      releaseLease(current);
    }
  });
  // 任意会话删除：冻结了该会话的租约中止，即使页面已切到其他会话。
  const offSessionDeleted = registry.onSessionDeleted((sessionId) => {
    if (current && current.frozen.kind === "active-chat"
      && current.frozen.chat.sessionId === sessionId) {
      releaseLease(current);
    }
  });
  // 通话结束：active-call 租约立即中止（唯一租约、唯一通话，无需比对代次）
  const offCallEnded = callController.onCallEnded(() => {
    if (current && current.frozen.kind === "active-call") {
      releaseLease(current);
    }
  });

  return {
    async acquireForPlugin(owner, acquireOptions) {
      if (disposed) {
        throw pluginHostError("E_PLUGIN_STOPPING", "宿主正在退出，语音输入服务不可用");
      }
      if (owner.signal.aborted) {
        throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${owner.pluginId} 已停止，无法取得语音输入租约`);
      }
      const target = (acquireOptions ?? {}).target;
      if (target !== "active-chat" && target !== "active-call") {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法语音输入目标: ${String(target)}`);
      }
      if (current) {
        throw pluginHostError(
          "E_SPEECH_INPUT_BUSY",
          `语音输入租约正被插件 ${current.pluginId} 占用`,
        );
      }
      let frozen: FrozenSpeechInputLeaseTarget;
      if (target === "active-chat") {
        const active = registry.getActive();
        if (!active) {
          throw pluginHostError("E_NO_ACTIVE_INPUT_TARGET", "当前没有可用的聊天输入目标");
        }
        frozen = { kind: "active-chat", chat: { ...active } };
      } else {
        // 同步接管通话输入：无活动通话返回 null，成功则停止内置 ASR 并冻结代次
        const claim = callController.claimExternalInput();
        if (!claim) {
          throw pluginHostError("E_NO_ACTIVE_INPUT_TARGET", "当前没有进行中的通话");
        }
        frozen = { kind: "active-call", callGeneration: claim.callGeneration };
      }

      // 同步临界区：到这里为止没有 await，检查占用与冻结目标之间不会插入其他 acquire
      const state: LeaseState = {
        key: `speech-input-lease-${randomUUID()}`,
        pluginId: owner.pluginId,
        ownerSignal: owner.signal,
        frozen,
        controller: new AbortController(),
        released: false,
        queue: Promise.resolve(),
        unsubscribe: [],
      };
      current = state;

      // 插件停止也走同一条释放路径（资源跟踪器清理时同样收敛到 releaseLease）
      const onOwnerAbort = () => releaseLease(state);
      try {
        owner.tracker.track("speech-input-lease", state.key, () => releaseLease(state));
      } catch (error) {
        releaseLease(state);
        throw pluginHostError(
          "E_PLUGIN_STOPPING",
          `插件 ${owner.pluginId} 已停止，语音输入租约登记失败`,
          { cause: error },
        );
      }
      owner.signal.addEventListener("abort", onOwnerAbort, { once: true });
      state.unsubscribe.push(() => owner.signal.removeEventListener("abort", onOwnerAbort));
      // 竞态兜底：登记资源与挂监听之间插件恰好停止
      if (owner.signal.aborted) {
        releaseLease(state);
        owner.tracker.forget("speech-input-lease", state.key);
        throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${owner.pluginId} 已停止，无法取得语音输入租约`);
      }

      return {
        signal: state.controller.signal,
        async commit(text) {
          if (typeof text !== "string" || text.trim().length === 0) {
            throw pluginHostError("E_INVALID_ARGUMENT", "提交文本不能为空");
          }
          if (state.ownerSignal.aborted) {
            throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${state.pluginId} 已停止，语音租约不可用`);
          }
          if (state.released) {
            throw pluginHostError("E_NOT_FOUND", "语音输入租约已释放");
          }
          // 串行执行：前一次 commit（无论成败）结束后才开始本次
          const run = state.queue.then(async () => {
            if (state.released) {
              throw pluginHostError("E_NOT_FOUND", "语音输入租约已释放");
            }
            if (state.frozen.kind === "active-call") {
              // 通话代次、轮次状态等校验由通话控制器完成并以稳定错误码抛出
              callController.commitExternalText(state.frozen.callGeneration, text);
              return;
            }
            // 只看冻结会话是否仍存在；不校验当前 UI 显示的是哪个会话
            if ((await sessionStore.getSession(state.frozen.chat.sessionId)) == null) {
              throw pluginHostError("E_NOT_FOUND", `会话已删除: ${state.frozen.chat.sessionId}`);
            }
            // rendererTargetId 的迟到响应校验由提交桥负责
            return commitBridge.commit(state.frozen.chat, text);
          });
          state.queue = run.then(() => undefined, () => undefined);
          return run;
        },
        async release() {
          releaseLease(state);
          // 手动释放后从跟踪器摘除，避免 dispose 时重复执行（幂等但保持登记干净）
          owner.tracker.forget("speech-input-lease", state.key);
        },
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (current) {
        releaseLease(current);
      }
      offInvalidated();
      offSessionDeleted();
      offCallEnded();
    },
  };
}
