// 阶段 0 性能基线假桥层：在 React 挂载前安装内存版 chatStore / agui / settings 等桥。
// 目标是让真实 ChatPage + AgentRunController 走完整真实链路（水合、待发队列、run 事件流），
// 同时保证：不读写磁盘、不触碰真实用户数据、事件序列可按 seed 无限重放。

import type { ChatMessage, ChatSession, PendingChatMessage } from "../../shared/chat-types";
import type {
  AguiApi,
  AguiEvent,
  ChatStoreApi,
} from "../react/features/chat/pages/chat-page-bridge";
import {
  buildPerfSession,
  buildStreamingScript,
  perfSessionMeta,
  runFinishedEvent,
  type PerfDataset,
  type StreamingScript,
} from "./fixture";

export interface FakeBridgeOptions {
  dataset: PerfDataset;
  count: number;
  seed: number;
  durationMs: number;
}

export interface FakeBridgeRuntime {
  session: ChatSession;
  script: StreamingScript;
  /** agui 每次发出事件的回调（main.tsx 用于记录事件到绘制延迟的起点） */
  onEmit: (callback: (event: AguiEvent, atMs: number) => void) => void;
  /** 事件脚本是否已全部发完 */
  isScriptFinished: () => boolean;
  /** agui.run 被调用的次数（驱动成功的判定） */
  getRunCalls: () => number;
}

function cloneSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
  };
}

/** 安装全部假桥；必须在 createRoot().render() 之前调用 */
export function installFakeBridges(options: FakeBridgeOptions): FakeBridgeRuntime {
  const session = buildPerfSession({
    dataset: options.dataset,
    count: options.count,
    seed: options.seed,
  });
  const script = buildStreamingScript({
    dataset: options.dataset,
    seed: options.seed,
    durationMs: options.durationMs,
  });

  let emitListener: ((event: AguiEvent, atMs: number) => void) | null = null;
  let scriptFinished = false;
  let runCalls = 0;

  // ── 内存版 agui：run() 被调用后按绝对时间表重放事件脚本 ──
  const aguiSubscribers = new Set<(event: AguiEvent) => void>();
  const emit = (event: AguiEvent) => {
    emitListener?.(event, performance.now());
    for (const subscriber of aguiSubscribers) subscriber(event);
  };

  let replayTimer: number | undefined;
  const stopReplay = () => {
    if (replayTimer !== undefined) window.clearTimeout(replayTimer);
    replayTimer = undefined;
  };

  const fakeAgui: AguiApi = {
    run: async () => {
      runCalls += 1;
      scriptFinished = false;
      const startedAt = performance.now();
      let index = 0;
      const step = () => {
        if (index >= script.events.length) {
          scriptFinished = true;
          return;
        }
        const next = script.events[index]!;
        const delay = Math.max(0, next.atMs - (performance.now() - startedAt));
        replayTimer = window.setTimeout(() => {
          index += 1;
          emit(next.event);
          step();
        }, delay);
      };
      step();
      return { success: true, runId: "perf-run-1" };
    },
    onEvent: (callback) => {
      aguiSubscribers.add(callback);
      return () => aguiSubscribers.delete(callback);
    },
    cancel: async () => {
      stopReplay();
      scriptFinished = true;
      emit(runFinishedEvent("perf-run-1", "cancelled"));
    },
    reportRunPersisted: () => {},
    getInterruptedRun: async () => null,
  };

  // ── 内存版 chatStore：完整实现 ChatStoreApi，所有变更只发生在内存 session 上 ──
  const pendingQueue: PendingChatMessage[] = [];

  const fakeStore: ChatStoreApi = {
    list: async () => [perfSessionMeta(session)],
    get: async (id) => (id === session.id ? cloneSession(session) : null),
    create: async () => cloneSession(session),
      checkpointPresentation: async (id, messageId, _mutationKey, patch) => {
      if (id !== session.id) return { ok: false, error: "session not found" };
      const target = session.messages.find((item) => item.id === messageId);
      if (target) {
        Object.assign(target, patch);
      }
      return { ok: true };
    },
    rename: async () => cloneSession(session),
    delete: async () => true,
    pendingEnqueue: async (id, entry) => {
      if (id !== session.id) return { ok: false, error: "session not found" };
      pendingQueue.push({ ...entry, enqueuedAt: Date.now() });
      return { ok: true, queue: [...pendingQueue] };
    },
    pendingList: async (id) => (id === session.id ? [...pendingQueue] : null),
    pendingRemove: async (id, messageId) => {
      if (id !== session.id) return { ok: false, error: "session not found" };
      const index = pendingQueue.findIndex((item) => item.id === messageId);
      if (index !== -1) pendingQueue.splice(index, 1);
      return { ok: true };
    },
    pendingClaim: async (id) => {
      if (id !== session.id) return { ok: false, error: "session not found" };
      const entry = pendingQueue.shift();
      if (!entry) return { ok: true, claimed: false };
      const userMessage: ChatMessage = {
        id: entry.id,
        role: "user",
        content: entry.rawContent,
        at: Date.now(),
        ...(entry.userSticker ? { sticker: entry.userSticker } : {}),
      };
      session.messages.push(userMessage);
      return {
        ok: true,
        claimed: true,
        userMessage,
        visibleContent: entry.visibleContent,
        remainingQueue: [...pendingQueue],
        session: cloneSession(session),
      };
    },
    pendingCompleteDispatch: async () => ({ ok: true }),
    pendingEdit: async (id, messageId, update) => {
      if (id !== session.id) return { ok: false, error: "session not found", queue: [...pendingQueue] };
      const entry = pendingQueue.find((item) => item.id === messageId);
      if (entry) {
        entry.rawContent = update.rawContent;
        entry.visibleContent = update.visibleContent;
        entry.userSticker = update.userSticker;
      }
      return { ok: true, queue: [...pendingQueue] };
    },
    pendingAdjust: async () => ({ ok: false, error: "perf harness 不支持调整", queue: [...pendingQueue] }),
    setPinned: async () => cloneSession(session),
    setModelProfile: async () => cloneSession(session),
    pickWorkspaceFolder: async () => ({ ok: false }),
    setWorkspace: async () => ({ ok: true }),
    initLearnWorkspace: async () => ({ ok: true }),
    openWorkspace: async () => ({ ok: true }),
    setActiveSession: async () => null,
    onChanged: () => () => {},
    onReactSwitchSession: () => () => {},
    notifyReactReady: () => {},
    getRendererTargetId: () => "perf-harness",
    onSpeechInputCommitRequest: () => () => {},
    sendSpeechInputCommitResult: () => {},
  };

  const noopUnsubscribe = () => () => {};

  // ── 其余桥：最小可用桩（harness 不触发这些交互路径，挂载期调用需安全返回） ──
  const fakeChat = {
    getGeneralSettings: async () => ({
      ttsEarlyReadSplitEnabled: false,
      ttsEarlyReadSplitMode: "sentence",
      currentStyleId: undefined,
    }),
    getEnabledStickers: async () => [],
    // 附件预览与图片标记在 harness 中不触发，但保留安全空实现防止调用崩溃
    getImagePreview: async () => ({ ok: false }),
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
  };
  const fakeSettings = {
    onPermissionApprovalRequest: noopUnsubscribe,
    onPermissionApprovalSettled: noopUnsubscribe,
    onPopQuizRequest: noopUnsubscribe,
    onPopQuizSettled: noopUnsubscribe,
    resolvePermissionApproval: async () => ({ ok: true }),
    resolvePopQuiz: async () => ({ ok: true, correct: true, explanation: "" }),
    skipPopQuiz: async () => ({ ok: true }),
  };
  const fakeSidebar = { openSettings: () => {} };
  const fakeModelConfig = { get: async () => ({}), onChanged: noopUnsubscribe };
  const fakeChoice = { resolve: async () => ({ ok: true }) };

  const target = window as unknown as Record<string, unknown>;
  target.chatStore = fakeStore;
  target.agui = fakeAgui;
  target.chat = fakeChat;
  target.settings = fakeSettings;
  target.sidebar = fakeSidebar;
  target.modelConfig = fakeModelConfig;
  target.choice = fakeChoice;

  return {
    session,
    script,
    onEmit: (callback) => {
      emitListener = callback;
    },
    isScriptFinished: () => scriptFinished,
    getRunCalls: () => runCalls,
  };
}
