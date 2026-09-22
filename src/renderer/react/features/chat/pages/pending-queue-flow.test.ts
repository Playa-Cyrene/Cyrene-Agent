import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession, ConversationMode, PendingChatMessage } from "../../../../../shared/chat-types";
import type { ComposerAttachment } from "../components/ChatComposer";
import type { ChatStoreApi, PendingClaimResult } from "./chat-page-bridge";
import {
  createPendingQueueFlow,
  type PendingQueueFlow,
  type PendingQueueFlowHost,
} from "./pending-queue-flow";

/**
 * 页面待发队列流程级测试：入队 → 认领 → 派发 → 刷新恢复 → 失败时序全链路。
 * 用替身 store 与记录型宿主驱动真实的流程模块（ChatPage 接线的同一实现），
 * 验证页面链路的关键不变量：稳定标识复用、不重复追加、认领缺失暂停、失败保留队首。
 */

// 老版本 Node 无全局 crypto.randomUUID 时提供确定性替身
beforeAll(() => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    let seq = 0;
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => `uuid-${++seq}` },
      configurable: true,
    });
  }
});

type FakeStore = ChatStoreApi & {
  get: ReturnType<typeof vi.fn>;
  pendingEnqueue: ReturnType<typeof vi.fn>;
  pendingList: ReturnType<typeof vi.fn>;
  pendingClaim: ReturnType<typeof vi.fn>;
  pendingCompleteDispatch: ReturnType<typeof vi.fn>;
  pendingRemove: ReturnType<typeof vi.fn>;
  pendingEdit: ReturnType<typeof vi.fn>;
  pendingAdjust: ReturnType<typeof vi.fn>;
};

function createFakeStore(): FakeStore {
  return {
    get: vi.fn(async () => null),
    pendingEnqueue: vi.fn(async () => ({ ok: true, queue: [] as PendingChatMessage[] })),
    pendingList: vi.fn(async () => [] as PendingChatMessage[]),
    pendingClaim: vi.fn(async () => ({ ok: true, claimed: false }) as PendingClaimResult),
    pendingCompleteDispatch: vi.fn(async () => ({ ok: true, cleared: true })),
    pendingRemove: vi.fn(async () => ({ ok: true })),
    pendingEdit: vi.fn(async () => ({ ok: true, queue: [] as PendingChatMessage[] })),
    pendingAdjust: vi.fn(async () => ({ ok: true, queue: [] as PendingChatMessage[] })),
  } as unknown as FakeStore;
}

interface FlowHarness {
  flow: PendingQueueFlow;
  store: FakeStore;
  calls: {
    runs: Array<Record<string, unknown>>;
    appended: Array<{ sessionId: string; items: Array<{ id: string; role: string }> }>;
    errors: string[];
    prepared: Array<{ sessionId: string; messageId: string; attachments: ComposerAttachment[] }>;
    refreshedModes: ConversationMode[];
    projectionReplaces: Array<{ sessionId: string; queue: PendingChatMessage[] | null }>;
  };
  busySessions: Set<string>;
  renderedMessages: Set<string>;
}

function createHarness(): FlowHarness {
  const store = createFakeStore();
  const calls: FlowHarness["calls"] = {
    runs: [],
    appended: [],
    errors: [],
    prepared: [],
    refreshedModes: [],
    projectionReplaces: [],
  };
  const busySessions = new Set<string>();
  const renderedMessages = new Set<string>();
  const host: PendingQueueFlowHost = {
    getStore: () => store,
    isSessionBusy: (sessionId) => busySessions.has(sessionId),
    hasRenderedMessage: (sessionId, messageId) => renderedMessages.has(`${sessionId}::${messageId}`),
    replaceProjection: (sessionId, queue) => {
      calls.projectionReplaces.push({ sessionId, queue });
    },
    appendMessages: (sessionId, items) => {
      calls.appended.push({ sessionId, items: items.map((item) => ({ id: item.id, role: item.role })) });
    },
    prepareImageAttachments: (sessionId, messageId, attachments) => {
      calls.prepared.push({ sessionId, messageId, attachments });
    },
    refreshSessions: (mode) => {
      calls.refreshedModes.push(mode);
    },
    startRun: async (input) => {
      calls.runs.push(input as unknown as Record<string, unknown>);
    },
    reportError: (message) => {
      calls.errors.push(message);
    },
  };
  return { flow: createPendingQueueFlow(() => host), store, calls, busySessions, renderedMessages };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    mode: "chat",
    messages: [],
    ...overrides,
  } as ChatSession;
}

function makeQueueEntry(id: string): PendingChatMessage {
  return { id, rawContent: `内容-${id}`, visibleContent: `内容-${id}`, enqueuedAt: 1 };
}

function makeClaimed(overrides: Partial<Extract<PendingClaimResult, { claimed: true }>> = {}): Extract<PendingClaimResult, { claimed: true }> {
  return {
    ok: true,
    claimed: true,
    userMessage: { id: "q-1", role: "user", content: "排队消息", at: 1 },
    visibleContent: "排队消息",
    remainingQueue: [],
    session: makeSession(),
    ...overrides,
  };
}

/** 等待 handleRunFinished 内部的 void 异步链（syncProjection/consume）跑完 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("页面待发队列流程", () => {
  it("入队成功刷新投影；认领派发补占位并启动带 claimedPendingMessageId 的 run", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEnqueue.mockResolvedValue({
      ok: true,
      queue: [makeQueueEntry("q-2"), makeQueueEntry("q-3")],
    });

    const ok = await flow.enqueue("s1", "chat", { id: "u-1", rawContent: "你好", visibleContent: "你好" });
    expect(ok).toBe(true);
    expect(store.pendingEnqueue).toHaveBeenCalledWith("s1", expect.objectContaining({ id: "u-1", rawContent: "你好" }));
    // 空闲会话入队不刷投影：消息马上会被认领转正，避免队列 Dock 闪现
    expect(calls.projectionReplaces).toHaveLength(0);

    // 空闲会话立即认领派发
    store.get.mockResolvedValue(makeSession());
    store.pendingClaim.mockResolvedValue(makeClaimed({
      remainingQueue: [makeQueueEntry("q-2")],
      resumeFromRunId: "run-old",
    }));
    await flow.consume("chat", "s1");

    expect(store.pendingClaim).toHaveBeenCalledWith("s1");
    // 认领后投影替换为权威剩余队列
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-2"]);
    // 渲染态追加用户消息 + 助手占位各一条
    expect(calls.appended).toHaveLength(1);
    expect(calls.appended[0].items.map((item) => item.role)).toEqual(["user", "assistant"]);
    // run 输入：认领派发标识 + 恢复 runId，绝不再追加用户消息
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0]).toMatchObject({
      sessionId: "s1",
      userMessageId: "q-1",
      claimedPendingMessageId: "q-1",
      resumeFromRunId: "run-old",
    });
    expect(calls.refreshedModes).toContain("chat");
  });

  it("空闲会话发送首条消息：入队不刷投影，认领往返期间队列 Dock 不再闪现", async () => {
    const { flow, store, calls } = createHarness();
    // 复现 ChatPage.sendMessage 在空闲会话上的真实时序：入队成功后立即消费。
    // 认领是一次 IPC 往返且要写盘：用挂起的 Promise 卡住它，观察认领返回前的投影状态
    store.pendingEnqueue.mockResolvedValue({ ok: true, queue: [makeQueueEntry("u-1")] });
    store.get.mockResolvedValue(makeSession());
    let resolveClaim!: (value: PendingClaimResult) => void;
    store.pendingClaim.mockImplementation(
      () => new Promise<PendingClaimResult>((resolve) => { resolveClaim = resolve; }),
    );

    // 第一步：入队确认成功——空闲会话不刷新投影，队列 Dock 不渲染这条消息
    const enqueued = await flow.enqueue("s1", "chat", { id: "u-1", rawContent: "你好", visibleContent: "你好" });
    expect(enqueued).toBe(true);
    expect(calls.projectionReplaces).toHaveLength(0);

    // 第二步：消费进行中（真实场景里是 IPC 往返 + 写盘的耗时窗口）：
    // 投影始终未带上这条消息，Dock 全程不出现——这就是修复后的行为
    const consuming = flow.consume("chat", "s1");
    await flushAsync();
    expect(calls.projectionReplaces).toHaveLength(0);

    // 认领完成后以权威剩余队列（空）替换投影：无需经过"显示再清空"的中间态
    resolveClaim(makeClaimed({ remainingQueue: [] }));
    await consuming;
    expect(calls.projectionReplaces).toEqual([{ sessionId: "s1", queue: [] }]);
  });

  it("会话忙时入队：立即刷新投影显示队列（消息会留队等待）", async () => {
    const { flow, store, calls, busySessions } = createHarness();
    busySessions.add("s1");
    store.pendingEnqueue.mockResolvedValue({ ok: true, queue: [makeQueueEntry("u-1")] });

    const ok = await flow.enqueue("s1", "chat", { id: "u-1", rawContent: "排队", visibleContent: "排队" });
    expect(ok).toBe(true);
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["u-1"]);
  });

  it("入队失败：报错保留草稿（返回 false）；同内容重试复用原稳定标识，成功后缓存清除", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEnqueue.mockResolvedValueOnce({ ok: false, error: "write-failed" });

    const first = await flow.enqueue("s1", "chat", { id: "a-1", rawContent: "同文", visibleContent: "同文" });
    expect(first).toBe(false);
    expect(calls.errors).toHaveLength(1);

    // 重试：调用方生成新 id，流程必须替换为失败缓存的 a-1（回执丢失靠主进程幂等去重）
    store.pendingEnqueue.mockResolvedValueOnce({ ok: true, queue: [] });
    const retry = await flow.enqueue("s1", "chat", { id: "b-2", rawContent: "同文", visibleContent: "同文" });
    expect(retry).toBe(true);
    expect(store.pendingEnqueue).toHaveBeenLastCalledWith("s1", expect.objectContaining({ id: "a-1" }));

    // 成功后缓存清除：再发同内容使用新 id
    store.pendingEnqueue.mockResolvedValueOnce({ ok: true, queue: [] });
    await flow.enqueue("s1", "chat", { id: "c-3", rawContent: "同文", visibleContent: "同文" });
    expect(store.pendingEnqueue).toHaveBeenLastCalledWith("s1", expect.objectContaining({ id: "c-3" }));
  });

  it("入队请求异常（IPC reject）：返回 false 并报错；重试同样复用原标识", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEnqueue.mockRejectedValueOnce(new Error("ipc broken"));

    const first = await flow.enqueue("s1", "chat", { id: "x-1", rawContent: "异常重试", visibleContent: "异常重试" });
    expect(first).toBe(false);
    expect(calls.errors).toHaveLength(1);

    store.pendingEnqueue.mockResolvedValueOnce({ ok: true, queue: [] });
    await flow.enqueue("s1", "chat", { id: "y-2", rawContent: "异常重试", visibleContent: "异常重试" });
    expect(store.pendingEnqueue).toHaveBeenLastCalledWith("s1", expect.objectContaining({ id: "x-1" }));
  });

  it("不完整附件（缺文件路径）整条拒绝：不发出入队请求并报错", async () => {
    const { flow, store, calls } = createHarness();
    const incomplete = { kind: "image", name: "半截.png", filePath: undefined } as unknown as ComposerAttachment;

    const ok = await flow.enqueue("s1", "chat", {
      id: "u-9",
      rawContent: "带附件",
      visibleContent: "带附件",
      attachments: [incomplete],
    });
    expect(ok).toBe(false);
    expect(store.pendingEnqueue).not.toHaveBeenCalled();
    expect(calls.errors).toHaveLength(1);
  });

  it("刷新恢复（未派发，含 run 已接受但确认失败/回答未落盘）：清派发簿记且绝不自动续派", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "q-1", claimedAt: 1 },
      messages: [{ id: "q-1", role: "user", content: "排队消息", at: 1 } as ChatMessage],
    });
    // 第一次 get：发现残留认领（无终态回答）；第二次 get（清账后继续消费）：无认领
    store.get.mockResolvedValueOnce(session).mockResolvedValueOnce(makeSession());
    store.pendingCompleteDispatch.mockResolvedValue({ ok: true, cleared: true });
    store.pendingClaim.mockResolvedValue({ ok: true, claimed: false });

    await flow.consume("chat", "s1");

    // 残留认领恢复：只清派发簿记——消息已在权威轨迹（认领/读取时 reconcile 落盘），
    // 以「已发送未回答」留在历史；没有新的用户意图，不为它启动第二次 run
    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("s1", "q-1");
    expect(calls.appended).toHaveLength(0);
    expect(calls.runs).toHaveLength(0);
    // 清账后继续消费队列（队列空 → 认领返回 claimed=false，兜底同步投影）
    expect(store.pendingClaim).toHaveBeenCalledWith("s1");
    expect(store.pendingList).toHaveBeenCalledWith("s1");
  });

  it("残留认领未回答且队列还有下一条：清旧账后只派发下一条，旧消息留在历史", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "q-1", claimedAt: 1 },
      messages: [{ id: "q-1", role: "user", content: "旧消息", at: 1 } as ChatMessage],
    });
    store.get.mockResolvedValueOnce(session).mockResolvedValueOnce(makeSession());
    store.pendingCompleteDispatch.mockResolvedValue({ ok: true, cleared: true });
    store.pendingClaim.mockResolvedValueOnce(makeClaimed({
      userMessage: { id: "q-2", role: "user", content: "新消息", at: 2 },
      visibleContent: "新消息",
      remainingQueue: [],
    }));

    await flow.consume("chat", "s1");

    // 旧认领只清账：绝不为它启动 run（那是自动补发）
    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("s1", "q-1");
    expect(calls.runs).toHaveLength(1);
    // 唯一的 run 属于下一条排队消息（用户既有意图的延迟执行）
    expect(calls.runs[0]).toMatchObject({
      sessionId: "s1",
      userMessageId: "q-2",
      claimedPendingMessageId: "q-2",
    });
  });

  it("清账写盘失败：保留恢复入口不认领不派发，等下一个触发点重试", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "q-1", claimedAt: 1 },
      messages: [{ id: "q-1", role: "user", content: "排队消息", at: 1 } as ChatMessage],
    });
    store.get.mockResolvedValue(session);
    store.pendingCompleteDispatch.mockResolvedValueOnce({ ok: false, error: "write-failed" });

    await flow.consume("chat", "s1");

    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("s1", "q-1");
    expect(store.pendingClaim).not.toHaveBeenCalled();
    expect(calls.runs).toHaveLength(0);
  });

  it("刷新恢复（已派发）：关联终态回答存在时清派发簿记并继续消费下一条，不再启动 run", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "q-1", claimedAt: 1 },
      messages: [
        { id: "q-1", role: "user", content: "排队消息", at: 1 },
        {
          id: "a-1",
          role: "model",
          content: "终态回答",
          at: 2,
          answersUserMessageId: "q-1",
          runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 2 },
        },
      ] as ChatMessage[],
    });
    // 第一次 get：发现残留认领并评估为已派发；第二次 get（清簿记后继续消费）：无认领
    store.get.mockResolvedValueOnce(session).mockResolvedValueOnce(makeSession());
    store.pendingCompleteDispatch.mockResolvedValue({ ok: true, cleared: true });
    store.pendingClaim.mockResolvedValue({ ok: true, claimed: false });

    await flow.consume("chat", "s1");

    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("s1", "q-1");
    // 不为已获回答的认领再启动 run，继续尝试认领下一条
    expect(calls.runs).toHaveLength(0);
    expect(store.pendingClaim).toHaveBeenCalledWith("s1");
  });

  it("恢复判定的关联性：终态回答属于其他用户轮次（answersUserMessageId 不匹配）时不误判已派发，同样只清账不续派", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "q-1", claimedAt: 1 },
      messages: [
        { id: "q-1", role: "user", content: "排队消息", at: 1 },
        {
          id: "a-old",
          role: "model",
          content: "旧轮次的迟到回答",
          at: 2,
          answersUserMessageId: "m-0",
          runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 2 },
        },
      ] as ChatMessage[],
    });
    store.get.mockResolvedValueOnce(session).mockResolvedValueOnce(makeSession());
    store.pendingCompleteDispatch.mockResolvedValue({ ok: true, cleared: true });
    store.pendingClaim.mockResolvedValue({ ok: true, claimed: false });

    await flow.consume("chat", "s1");

    // 迟到的他人轮次回答不算本认领已派发，但新语义下两个分支同样只清账：
    // 不为该认领启动 run（绝不自动补发），继续消费队列
    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("s1", "q-1");
    expect(calls.runs).toHaveLength(0);
    expect(store.pendingClaim).toHaveBeenCalledWith("s1");
  });

  it("认领记录指向的消息缺失：报错并暂停该会话队列；其他会话不受影响", async () => {
    const { flow, store, calls } = createHarness();
    const session = makeSession({
      pendingDispatch: { messageId: "ghost", claimedAt: 1 },
      messages: [],
    });
    store.get.mockResolvedValue(session);

    await flow.consume("chat", "s1");

    // 暂停并报错：不清派发簿记、不认领、不派发
    expect(calls.errors).toHaveLength(1);
    expect(store.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(store.pendingClaim).not.toHaveBeenCalled();
    expect(calls.runs).toHaveLength(0);

    // 该会话已暂停：再次消费直接返回，不再触达存储
    store.get.mockClear();
    await flow.consume("chat", "s1");
    expect(store.get).not.toHaveBeenCalled();

    // 其他会话不受暂停影响
    store.get.mockResolvedValueOnce(makeSession({ id: "s2" }));
    store.pendingClaim.mockResolvedValueOnce({ ok: true, claimed: false });
    await flow.consume("chat", "s2");
    expect(store.get).toHaveBeenCalledWith("s2");
  });

  it("认领写盘失败：保留队首不派发；兜底同步投影让队列消息可见，恢复后重试认领成功", async () => {
    const { flow, store, calls } = createHarness();
    store.get.mockResolvedValue(makeSession());
    store.pendingClaim.mockResolvedValueOnce({ ok: false, error: "write-failed" });

    await flow.consume("chat", "s1");
    expect(calls.runs).toHaveLength(0);
    // 认领失败：入队时跳过刷新的消息仍在权威队列里，兜底同步让页面可见
    expect(store.pendingList).toHaveBeenCalledWith("s1");
    expect(calls.projectionReplaces).toEqual([{ sessionId: "s1", queue: [] }]);

    // 下一个触发点重试：认领成功，正常派发
    store.get.mockResolvedValueOnce(makeSession());
    store.pendingClaim.mockResolvedValueOnce(makeClaimed());
    await flow.consume("chat", "s1");
    expect(calls.runs).toHaveLength(1);
  });

  it("会话已删除：清除投影；busy 会话：跳过消费；空队列/他窗已认领：不启动 run", async () => {
    const { flow, store, calls, busySessions } = createHarness();

    // 会话删除：投影清除（null）
    store.get.mockResolvedValueOnce(null);
    await flow.consume("chat", "s1");
    expect(calls.projectionReplaces.at(-1)).toEqual({ sessionId: "s1", queue: null });

    // busy：不触达存储
    store.get.mockClear();
    busySessions.add("s1");
    await flow.consume("chat", "s1");
    expect(store.get).not.toHaveBeenCalled();
    busySessions.delete("s1");

    // 空队列
    store.get.mockResolvedValueOnce(makeSession());
    store.pendingClaim.mockResolvedValueOnce({ ok: true, claimed: false });
    await flow.consume("chat", "s1");
    expect(calls.runs).toHaveLength(0);

    // 他窗已认领（already-dispatching）
    store.get.mockResolvedValueOnce(makeSession());
    store.pendingClaim.mockResolvedValueOnce({ ok: false, error: "already-dispatching" });
    await flow.consume("chat", "s1");
    expect(calls.runs).toHaveLength(0);
  });

  it("附件快照认领派发：附件转为 pending 状态并走图片预处理", async () => {
    const { flow, store, calls } = createHarness();
    store.get.mockResolvedValue(makeSession());
    store.pendingClaim.mockResolvedValue(makeClaimed({
      userMessage: {
        id: "q-att",
        role: "user",
        content: "带图消息",
        at: 1,
        attachments: [
          { kind: "image", name: "截图.png", filePath: "C:/tmp/shot.png", mime: "image/png", status: "pending" },
        ],
      },
    }));

    await flow.consume("chat", "s1");

    expect(calls.prepared).toHaveLength(1);
    expect(calls.prepared[0]).toMatchObject({ sessionId: "s1", messageId: "q-att" });
    expect(calls.prepared[0].attachments[0]).toMatchObject({ kind: "image", filePath: "C:/tmp/shot.png", status: "pending" });
    expect(calls.runs[0]).toMatchObject({ userMessageId: "q-att", claimedPendingMessageId: "q-att" });
    const runAttachments = calls.runs[0].attachments as ComposerAttachment[];
    expect(runAttachments[0]).toMatchObject({ kind: "image", status: "pending" });
  });

  it("handleRunFinished：queuePaused=true 暂停消费（不认领）；false 时消费下一条", async () => {
    const { flow, store, calls } = createHarness();

    // queuePaused：只刷新列表与投影，不消费
    flow.handleRunFinished({ mode: "chat", sessionId: "s1", queuePaused: true });
    await flushAsync();
    expect(store.pendingList).toHaveBeenCalledWith("s1");
    expect(store.get).not.toHaveBeenCalled();
    expect(store.pendingClaim).not.toHaveBeenCalled();
    expect(calls.refreshedModes).toContain("chat");

    // 正常结束：消费下一条（会话空闲、队列空 → 认领返回 claimed=false）
    store.get.mockResolvedValueOnce(makeSession());
    store.pendingClaim.mockResolvedValueOnce({ ok: true, claimed: false });
    flow.handleRunFinished({ mode: "chat", sessionId: "s1", queuePaused: false });
    await flushAsync();
    expect(store.pendingClaim).toHaveBeenCalledWith("s1");
  });

  it("editMessage 成功：透传三个文字字段并用返回的权威队列刷新投影", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEdit.mockResolvedValueOnce({
      ok: true,
      queue: [makeQueueEntry("q-2")],
    });

    const ok = await flow.editMessage("s1", "q-1", {
      rawContent: "改后的文字 [sticker:shy]",
      visibleContent: "改后的文字",
      userSticker: "shy",
    });
    expect(ok).toBe(true);
    expect(store.pendingEdit).toHaveBeenCalledWith("s1", "q-1", {
      rawContent: "改后的文字 [sticker:shy]",
      visibleContent: "改后的文字",
      userSticker: "shy",
    });
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-2"]);
    expect(calls.errors).toHaveLength(0);
  });

  it("editMessage 冲突（已认领）：用最新权威队列刷新投影（不覆盖新状态）并报错", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEdit.mockResolvedValueOnce({
      ok: false,
      error: "already-claimed",
      queue: [makeQueueEntry("q-2")],
    });

    const ok = await flow.editMessage("s1", "q-1", { rawContent: "迟到编辑", visibleContent: "迟到编辑" });
    expect(ok).toBe(false);
    // 冲突时也用附带队列刷新投影：页面立刻看到主进程的新状态
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-2"]);
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain("already-claimed");
  });

  it("editMessage 失败无队列（写盘失败等）：只报错，投影保持不动", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingEdit.mockResolvedValueOnce({ ok: false, error: "write-failed" });

    const ok = await flow.editMessage("s1", "q-1", { rawContent: "编辑", visibleContent: "编辑" });
    expect(ok).toBe(false);
    expect(calls.projectionReplaces).toHaveLength(0);
    expect(calls.errors).toHaveLength(1);
  });

  it("editMessage / adjustMessage 存储不可用：报错返回 false", async () => {
    const errors: string[] = [];
    const flow = createPendingQueueFlow(() => ({
      getStore: () => undefined,
      isSessionBusy: () => false,
      hasRenderedMessage: () => false,
      replaceProjection: () => {},
      appendMessages: () => {},
      prepareImageAttachments: () => {},
      refreshSessions: () => {},
      startRun: async () => {},
      reportError: (message: string) => errors.push(message),
    }));

    const editOk = await flow.editMessage("s1", "q-1", { rawContent: "编辑", visibleContent: "编辑" });
    expect(editOk).toBe(false);
    expect(errors[0]).toContain("聊天会话服务尚未就绪");

    const adjustOk = await flow.adjustMessage("s1", "q-1");
    expect(adjustOk).toBe(false);
    expect(errors[1]).toContain("聊天会话服务尚未就绪");
  });

  it("adjustMessage 成功：透传条目标识并用权威队列刷新投影", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingAdjust.mockResolvedValueOnce({
      ok: true,
      queue: [makeQueueEntry("q-2")],
    });

    const ok = await flow.adjustMessage("s1", "q-1");
    expect(ok).toBe(true);
    expect(store.pendingAdjust).toHaveBeenCalledWith("s1", "q-1");
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-2"]);
    expect(calls.errors).toHaveLength(0);
  });

  it("adjustMessage 无活跃运行/Chat 模式：明确提示不可调整，消息仍保留队列（投影刷新）", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingAdjust.mockResolvedValueOnce({
      ok: false,
      error: "no-active-run",
      queue: [makeQueueEntry("q-1")],
    });

    const ok = await flow.adjustMessage("s1", "q-1");
    expect(ok).toBe(false);
    // 条目仍留在队列：投影按最新权威队列刷新
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-1"]);
    // 错误文案是面向用户的"不可调整"提示，而不是裸错误码
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain("仍保留在队列中");

    // no-safe-next-step（Chat 模式）共用同一条用户文案
    store.pendingAdjust.mockResolvedValueOnce({
      ok: false,
      error: "no-safe-next-step",
      queue: [makeQueueEntry("q-1")],
    });
    await flow.adjustMessage("s1", "q-1");
    expect(calls.errors[1]).toContain("仍保留在队列中");
  });

  it("adjustMessage 带附件被拒：提示附件不可插入，条目留队", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingAdjust.mockResolvedValueOnce({
      ok: false,
      error: "has-attachments",
      queue: [makeQueueEntry("q-att")],
    });

    const ok = await flow.adjustMessage("s1", "q-att");
    expect(ok).toBe(false);
    expect(calls.projectionReplaces.at(-1)?.queue?.map((item) => item.id)).toEqual(["q-att"]);
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain("带附件");
  });

  it("adjustMessage 请求异常（IPC reject）：报错返回 false", async () => {
    const { flow, store, calls } = createHarness();
    store.pendingAdjust.mockRejectedValueOnce(new Error("ipc broken"));

    const ok = await flow.adjustMessage("s1", "q-1");
    expect(ok).toBe(false);
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain("ipc broken");
  });
});
