// dispatcher 核心单元测试：sessionId hash + 限速
import * as os from "node:os";
import { describe, it, expect, vi } from "vitest";
import {
  ChannelDispatcher,
  makeChannelTurnId,
  makeSessionId,
  type DispatcherDeps,
} from "./dispatcher";
import { appendHistory, migrateHistory } from "./history-log";
import { appendLog, reloadLogFromDisk } from "./message-log";
import { createOutgoingComposer } from "./outgoing-composer";
import { createChannelContext, type ChannelContext } from "./channel-context";
import { createKeyedQueue } from "./keyed-queue";
import { createChannelRateLimiter } from "./rate-limiter";
import { createChannelDeliveryService } from "./delivery-service";
import type { ChannelsSettings } from "./settings-store";
import type { IncomingMessage } from "./types";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => process.cwd(),
    getName: () => "Cyrene",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

vi.mock("./message-log", () => ({
  appendLog: vi.fn(),
  reloadLogFromDisk: vi.fn(),
}));

vi.mock("./history-log", () => ({
  appendHistory: vi.fn(),
  migrateHistory: vi.fn(),
}));

describe("channels/dispatcher", () => {
  function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      channel: "qq",
      chatType: "private",
      senderId: "user-1",
      senderName: "测试用户",
      chatId: "chat-1",
      text: "你好",
      at: new Date(0),
      ...overrides,
    };
  }

  function makeManager(send = vi.fn(async () => ({ ok: true }))) {
    return {
      getAdapter: () => ({
        capability: { text: true, image: true, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 4000 },
        send,
      }),
    } as any;
  }

  type TestDispatcherOptions = Partial<DispatcherDeps> & {
    manager?: ReturnType<typeof makeManager>;
    journal?: DispatcherDeps["journal"];
    loadRecentChannelHistory?: unknown;
    resolveBoundConversationId?: Parameters<typeof createChannelContext>[0]["resolveBoundConversationId"];
    loadBoundConversationHistory?: unknown;
    appendBoundConversationMessage?: unknown;
  };

  function makeDispatcher(options: TestDispatcherOptions): ChannelDispatcher {
    const manager = options.manager ?? makeManager();
    const baseComposer = options.composer ?? createOutgoingComposer({
      resolveStickerImagePath: (stickerId) => stickerId === "OK" ? "C:/stickers/ok.png" : null,
    });
    return new ChannelDispatcher({
      queue: options.queue ?? createKeyedQueue({ maxPendingPerKey: 20 }),
      limiter: options.limiter ?? createChannelRateLimiter({
        limits: { perUser: 10, perChannel: 100 },
      }),
      context: options.context ?? createChannelContext({
        resolveBoundConversationId: options.resolveBoundConversationId,
        migrateHistory,
      }),
      journal: options.journal ?? {
        appendUser: vi.fn(async (_conversationId: string, input: { id?: string }) => ({ id: input.id ?? "user-1" })),
        appendPresentation: vi.fn(async () => undefined),
        buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
        createRunSink: vi.fn(() => ({
          appendAssistant: vi.fn(async () => "assistant-1"),
          appendToolResult: vi.fn(async () => undefined),
          closeInterruption: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        })),
        appendDeliveryReceipt: vi.fn(async () => undefined),
      },
      composer: {
        compose: (input) => baseComposer.compose({
          ...input,
          capability: manager.getAdapter(input.incoming.channel)?.capability,
        }),
        cleanupTransientFiles: (files) => baseComposer.cleanupTransientFiles(files),
      },
      delivery: options.delivery ?? createChannelDeliveryService(manager),
      buildAndRunAgent: options.buildAndRunAgent ?? (async (msg) => ({
        text: `[回声][${msg.channel}][${msg.senderId}] ${msg.text}`,
        sticker: null,
      })),
      loadSettings: options.loadSettings ?? (() => ({
        rateLimitPerUser: 10,
        rateLimitPerChannel: 100,
        ttsEnabled: true,
        stickerEnabled: true,
        mirrorToDesktop: true,
      } as ChannelsSettings)),
      loadGeneralSettings: options.loadGeneralSettings ?? (() => ({})),
      observeExternalChat: options.observeExternalChat,
      broadcastChat: options.broadcastChat,
    });
  }

  async function flushMicrotasks(rounds = 12): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  }

  it("构造调度器时不读取消息日志", () => {
    vi.mocked(reloadLogFromDisk).mockClear();

    makeDispatcher({});

    expect(reloadLogFromDisk).not.toHaveBeenCalled();
  });

  it("turn ID 回退源中的换行会被压成空格，保证 entry ID 合法", () => {
    // 附件/多行正文在缺少 messageId 时走时间+正文回退，换行必须被清洗
    const withNewlines = makeChannelTurnId({
      ...makeIncoming({ text: "第一行\n第二行\r\n第三行" }),
    }, "user");
    expect(withNewlines).not.toMatch(/[\r\n]/);
    expect(withNewlines).toContain("第一行 第二行 第三行");
    // 透传 messageId 的消息直接使用平台 ID
    expect(makeChannelTurnId(makeIncoming({ messageId: "om_123" }), "user"))
      .toBe("qq:chat-1:om_123:user");
  });

  it("uses channel history and channel session when the chat is unbound", async () => {
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, input: { sessionId: string }) => {
      expect(input.sessionId).toBe(makeSessionId("qq", "chat-1"));
      return { text: "渠道回复", sticker: null };
    });
    const dispatcher = makeDispatcher({ manager: makeManager(), buildAndRunAgent: buildAndRunAgent as never });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it("通过注入的上下文模块读取和提交会话状态", async () => {
    const contextService: ChannelContext = {
      resolveDispatchContext: vi.fn((sessionId: string) => ({
        sessionId,
        boundConversationId: null,
      })),
      recordIncomingSession: vi.fn(),
    };
    const buildAndRunAgent = vi.fn(async (
      _msg: IncomingMessage,
      _input: unknown,
    ) => {
      return { text: "模块回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      context: contextService,
      buildAndRunAgent,
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(contextService.recordIncomingSession).toHaveBeenCalledOnce();
  });

  it.each(["qq", "wechat"] as const)("uses bound desktop history while keeping %s runtime identity separate", async (channel) => {
    const channelSessionId = makeSessionId(channel, "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "不应读取" }]);
    const loadBoundConversationHistory = vi.fn(async () => [{ role: "user" as const, content: "桌面旧消息" }]);
    const appendBoundConversationMessage = vi.fn();
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, input: { sessionId: string }) => {
      expect(input.sessionId).toBe(channelSessionId);
      return { text: "共享回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: vi.fn((sessionId: string) => sessionId === channelSessionId ? "conversation-7" : null),
      appendBoundConversationMessage,
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming({ channel }));

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).not.toHaveBeenCalled();
    expect(loadBoundConversationHistory).not.toHaveBeenCalled();
    expect(appendBoundConversationMessage).not.toHaveBeenCalled();
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it("keeps QQ group identity in model context without putting it in the visible bound message", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: () => "conversation-group",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: null })),
    });

    await dispatcher.handleIncoming(makeIncoming({
      channel: "qq",
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "大家好",
    }));

    expect(appendBoundConversationMessage).not.toHaveBeenCalled();
  });

  it("persists the same selected built-in sticker in the bound desktop reply", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: {
        getAdapter: () => ({
          capability: { text: true, image: true, audio: false, file: false, video: false, markdown: false, card: false, sticker: true, maxTextLength: 2048 },
          send: vi.fn(async () => ({ ok: true })),
        }),
      } as any,
      resolveBoundConversationId: () => "conversation-sticker",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: "OK" })),
    });

    await dispatcher.handleIncoming(makeIncoming({ channel: "wechat" }));

    expect(appendBoundConversationMessage).not.toHaveBeenCalled();
  });

  it("does not persist a selected sticker when the channel capability rejects stickers", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: () => "conversation-no-sticker",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: "OK" })),
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(appendBoundConversationMessage).not.toHaveBeenCalled();
  });

  it("falls back to channel history when bound desktop history cannot be loaded", async () => {
    const channelSessionId = makeSessionId("qq", "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道回退" }]);
    const loadBoundConversationHistory = vi.fn(async () => { throw new Error("桌面对话已删除"); });
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, input: { sessionId: string }) => {
      expect(input.sessionId).toBe(channelSessionId);
      return { text: "回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: () => "conversation-7",
      buildAndRunAgent,
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(loadRecentChannelHistory).not.toHaveBeenCalled();
    expect(loadBoundConversationHistory).not.toHaveBeenCalled();
    expect(buildAndRunAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: channelSessionId }));
  });

  it("falls back to the unbound channel path when binding lookup fails", async () => {
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道历史" }]);
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, input: { sessionId: string }) => {
      expect(input.sessionId).toBe(makeSessionId("qq", "chat-1"));
      return { text: "回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      resolveBoundConversationId: () => { throw new Error("绑定存储暂不可用"); },
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).not.toHaveBeenCalled();
  });

  it("适配器明确发送失败时不提交助手状态", async () => {
    vi.mocked(appendHistory).mockClear();
    vi.mocked(appendLog).mockClear();
    const appendBoundConversationMessage = vi.fn();
    const broadcastChat = vi.fn();
    const send = vi.fn(async () => ({ ok: false, error: "offline" }));
    const dispatcher = makeDispatcher({
      manager: makeManager(send),
      resolveBoundConversationId: () => "conversation-1",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      broadcastChat,
      buildAndRunAgent: vi.fn(async () => ({ text: "回复", sticker: null })),
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    expect(appendBoundConversationMessage).not.toHaveBeenCalled();
    expect(appendHistory).not.toHaveBeenCalledWith(
      makeSessionId("qq", "chat-1"),
      "assistant",
      expect.any(String),
    );
    expect(appendLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ dir: "outgoing" }),
    );
    expect(broadcastChat).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "bot:outgoing" }),
    );
  });

  it("通过注入的传输服务发送并在确认成功后提交", async () => {
    vi.mocked(appendHistory).mockClear();
    const dispatcher = makeDispatcher({
      manager: { getAdapter: () => undefined } as any,
      delivery: {
        send: vi.fn(async () => ({ ok: true })),
      },
      buildAndRunAgent: vi.fn(async () => ({ text: "传输成功", sticker: null })),
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.parts).toEqual([{ kind: "text", text: "传输成功" }]);
    expect(appendHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["发送成功", { ok: true } as const, false],
    ["发送失败", { ok: false, error: "offline" } as const, true],
  ])("%s后清理本轮生成的临时音频", async (_name, deliveryResult, expectsNull) => {
    const files = new Map<string, Buffer>();
    let filePresentDuringSend = false;
    const composer = createOutgoingComposer({
      audioDirectory: "C:/virtual/channels/audio",
      createId: () => "reply-audio",
      writeFile: async (filePath, data) => {
        files.set(filePath, data);
      },
      removeFile: async (filePath) => {
        files.delete(filePath);
      },
      synthesizeTts: async () => Buffer.from("audio"),
      resolveStickerImagePath: () => null,
    });
    const manager = {
      getAdapter: () => ({
        capability: {
          text: true,
          image: true,
          audio: true,
          file: true,
          video: true,
          markdown: true,
          card: true,
          sticker: true,
          maxTextLength: 4000,
        },
      }),
    } as any;
    const dispatcher = makeDispatcher({
      manager,
      composer,
      delivery: {
        send: async (message) => {
          const audio = message.parts.find((part) => part.kind === "audio");
          filePresentDuringSend = Boolean(
            audio?.kind === "audio" && files.has(audio.filePath),
          );
          return deliveryResult;
        },
      },
      buildAndRunAgent: vi.fn(async () => ({ text: "语音回复", sticker: null })),
    });

    const result = await dispatcher.handleIncoming(makeIncoming({ channel: "feishu" }));

    expect(filePresentDuringSend).toBe(true);
    expect(files.size).toBe(0);
    expect(result === null).toBe(expectsNull);
  });

  it("同一个外部会话的消息必须串行执行完整处理链", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let runCount = 0;
    const dispatcher = makeDispatcher({
      manager: makeManager(vi.fn(async (outgoing) => {
        events.push(`${outgoing.targetId}:sent`);
        return { ok: true };
      })),
      buildAndRunAgent: vi.fn(async (msg) => {
        runCount += 1;
        events.push(`${msg.text}:agent:start`);
        if (runCount === 1) {
          markFirstStarted();
          await firstGate;
        }
        events.push(`${msg.text}:agent:end`);
        return { text: `回复:${msg.text}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({ text: "第一条" }));
    await firstStarted;
    const second = dispatcher.handleIncoming(makeIncoming({ text: "第二条" }));
    await flushMicrotasks();

    try {
      expect(events).not.toContain("第二条:agent:start");
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(events.indexOf("第二条:agent:start"))
      .toBeGreaterThan(events.indexOf("chat-1:sent"));
  });

  it("不同外部会话绑定到同一桌面会话时必须串行", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(vi.fn(async (outgoing) => {
        events.push(`${outgoing.targetId}:sent`);
        return { ok: true };
      })),
      resolveBoundConversationId: () => "conversation-shared",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage: vi.fn(async (_conversationId, role, content) => {
        if (role === "assistant") events.push(`${content}:committed`);
      }),
      buildAndRunAgent: vi.fn(async (msg) => {
        events.push(`${msg.chatId}:agent:start`);
        if (msg.chatId === "chat-a") {
          markFirstStarted();
          await firstGate;
        }
        events.push(`${msg.chatId}:agent:end`);
        return { text: `回复:${msg.chatId}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-a",
      chatId: "chat-a",
    }));
    await firstStarted;
    const second = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-b",
      chatId: "chat-b",
    }));
    await flushMicrotasks();

    try {
      expect(events).not.toContain("chat-b:agent:start");
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(events.indexOf("chat-b:agent:start"))
      .toBeGreaterThan(events.indexOf("回复:chat-a:committed"));
  });

  it("不同桌面会话之间保持并行", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionA = makeSessionId("qq", "chat-a");
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: (sessionId) => (
        sessionId === sessionA ? "conversation-a" : "conversation-b"
      ),
      loadBoundConversationHistory: vi.fn(async () => []),
      buildAndRunAgent: vi.fn(async (msg) => {
        events.push(`${msg.chatId}:agent:start`);
        await gate;
        return { text: `回复:${msg.chatId}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-a",
      chatId: "chat-a",
    }));
    const second = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-b",
      chatId: "chat-b",
    }));
    await flushMicrotasks();

    try {
      expect(new Set(events)).toEqual(new Set([
        "chat-a:agent:start",
        "chat-b:agent:start",
      ]));
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it("同会话并发从 canonical journal 串行，且 agent 不接收历史旁路", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runCount = 0;
    const journal = {
      appendUser: vi.fn(async (_conversationId: string, input: { text: string; attachments?: unknown[] }) => {
        events.push(`${input.text}:user`);
        return { id: `user-${input.text}` };
      }),
      appendPresentation: vi.fn(async () => undefined),
      buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
      createRunSink: vi.fn(() => ({
        appendAssistant: vi.fn(async () => "assistant-1"),
        appendToolResult: vi.fn(async () => undefined),
        closeInterruption: vi.fn(async () => undefined),
        checkpoint: vi.fn(async () => undefined),
      })),
      appendDeliveryReceipt: vi.fn(async () => undefined),
    };
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, input: { transcriptSink: unknown }) => {
      expect(input.transcriptSink).toBeDefined();
      runCount += 1;
      if (runCount === 1) await firstGate;
      return { text: `回复-${runCount}`, sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      journal: journal as never,
      buildAndRunAgent: buildAndRunAgent as never,
    });

    const first = dispatcher.handleIncoming(makeIncoming({ text: "first", messageId: "m-1" }));
    await flushMicrotasks();
    const second = dispatcher.handleIncoming(makeIncoming({ text: "second", messageId: "m-2" }));
    await flushMicrotasks();
    expect(journal.appendUser).toHaveBeenCalledTimes(1);
    expect(buildAndRunAgent).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(journal.appendUser).toHaveBeenCalledTimes(2);
    expect(buildAndRunAgent.mock.calls[0]?.[1]).not.toHaveProperty("messages");
    expect(journal.buildModelContext).toHaveBeenCalledTimes(2);
  });

  it("发送失败写入 failed receipt 且保留已落盘 assistant", async () => {
    const appendDeliveryReceipt = vi.fn(async () => undefined);
    const appendAssistant = vi.fn(async () => "assistant-turn-1");
    const journal = {
      appendUser: vi.fn(async () => ({ id: "user-1" })),
      appendPresentation: vi.fn(async () => undefined),
      buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
      createRunSink: vi.fn(() => ({
        appendAssistant,
        appendToolResult: vi.fn(async () => undefined),
        closeInterruption: vi.fn(async () => undefined),
        checkpoint: vi.fn(async () => undefined),
      })),
      appendDeliveryReceipt,
    };
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      journal: journal as never,
      delivery: { send: vi.fn(async () => ({ ok: false as const, error: "offline" })) },
      buildAndRunAgent: vi.fn(async (_msg: IncomingMessage, input: { transcriptSink: { appendAssistant: (input: unknown) => Promise<string> } }) => {
        await input.transcriptSink.appendAssistant({ message: { role: "assistant", content: "回复" } });
        return { text: "回复", sticker: null };
      }) as never,
    });

    await expect(dispatcher.handleIncoming(makeIncoming({ messageId: "m-1" }))).resolves.toBeNull();
    expect(appendAssistant).toHaveBeenCalledOnce();
    expect(appendDeliveryReceipt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      assistantTurnId: "qq:chat-1:m-1:assistant",
      channel: "qq",
      status: "failed",
      errorCode: "offline",
    }));
  });

  it("预回执写失败时禁止发送", async () => {
    const delivery = vi.fn(async () => ({ ok: true as const }));
    const appendDeliveryReceipt = vi.fn(async () => { throw new Error("disk full"); });
    const dispatcher = makeDispatcher({
      journal: {
        appendUser: vi.fn(async () => ({ id: "user-1" })),
        appendPresentation: vi.fn(async () => undefined),
        buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
        createRunSink: vi.fn(() => ({
          appendAssistant: vi.fn(async () => "assistant-1"),
          appendToolResult: vi.fn(async () => undefined),
          closeInterruption: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        })),
        appendDeliveryReceipt,
      } as never,
      delivery: { send: delivery },
    });

    await expect(dispatcher.handleIncoming(makeIncoming({ messageId: "pre-fail" }))).resolves.toBeNull();
    expect(appendDeliveryReceipt).toHaveBeenCalledOnce();
    expect(delivery).not.toHaveBeenCalled();
  });

  it("最终 failed receipt 写失败时保留 DELIVERY_UNCONFIRMED 保守状态", async () => {
    const delivery = vi.fn(async () => ({ ok: false as const, error: "offline" }));
    const appendDeliveryReceipt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const dispatcher = makeDispatcher({
      journal: {
        appendUser: vi.fn(async () => ({ id: "user-1" })),
        appendPresentation: vi.fn(async () => undefined),
        buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
        createRunSink: vi.fn(() => ({
          appendAssistant: vi.fn(async () => "assistant-1"),
          appendToolResult: vi.fn(async () => undefined),
          closeInterruption: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        })),
        appendDeliveryReceipt,
      } as never,
      delivery: { send: delivery },
    });

    await expect(dispatcher.handleIncoming(makeIncoming({ messageId: "final-fail" }))).resolves.toBeNull();
    expect(delivery).toHaveBeenCalledOnce();
    expect(appendDeliveryReceipt).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      status: "failed", errorCode: "DELIVERY_UNCONFIRMED", revision: 1,
    }));
    expect(appendDeliveryReceipt).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      status: "failed", errorCode: "offline", revision: 2,
    }));
  });

  it("发送成功但 delivered receipt 写失败时保持保守状态且不重发", async () => {
    const delivery = vi.fn(async () => ({ ok: true as const }));
    const appendDeliveryReceipt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const dispatcher = makeDispatcher({
      journal: {
        appendUser: vi.fn(async () => ({ id: "user-1" })),
        appendPresentation: vi.fn(async () => undefined),
        buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
        createRunSink: vi.fn(() => ({
          appendAssistant: vi.fn(async () => "assistant-1"),
          appendToolResult: vi.fn(async () => undefined),
          closeInterruption: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        })),
        appendDeliveryReceipt,
      } as never,
      delivery: { send: delivery },
    });

    await expect(dispatcher.handleIncoming(makeIncoming({ messageId: "success-final-fail" }))).resolves.toEqual(expect.objectContaining({ targetId: "chat-1" }));
    expect(delivery).toHaveBeenCalledOnce();
    expect(appendDeliveryReceipt).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      status: "failed", errorCode: "DELIVERY_UNCONFIRMED", revision: 1,
    }));
    expect(appendDeliveryReceipt).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      status: "delivered", revision: 2,
    }));
  });

  it("canonical user 条目保留附件和渠道来源展示补丁", async () => {
    const appendUser = vi.fn(async (_conversationId: string, input: { id?: string }) => ({ id: input.id ?? "user-1" }));
    const appendPresentation = vi.fn(async () => undefined);
    const dispatcher = makeDispatcher({
      journal: {
        appendUser,
        appendPresentation,
        buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
        createRunSink: vi.fn(() => ({
          appendAssistant: vi.fn(async () => "assistant-1"),
          appendToolResult: vi.fn(async () => undefined),
          closeInterruption: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        })),
        appendDeliveryReceipt: vi.fn(async () => undefined),
      } as never,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: null })) as never,
    });

    await dispatcher.handleIncoming(makeIncoming({
      messageId: "m-attachment",
      text: "看这个",
      chatType: "group",
      attachments: [{ kind: "image", filePath: "C:/inbox/a.png", mime: "image/png" }],
    }));

    expect(appendUser).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      text: expect.stringContaining("看这个"),
      attachments: [{ kind: "image", name: "a.png", filePath: "C:/inbox/a.png", mime: "image/png" }],
    }));
    expect(appendPresentation).toHaveBeenCalledWith(expect.any(String), expect.any(String), 1, expect.objectContaining({
      content: "看这个",
      channelSource: { channel: "qq", chatType: "group", senderName: "测试用户" },
    }));
  });

  function makeReplayJournal(options: {
    finalStatus?: "delivered" | "failed";
    failFinalReceipt?: boolean;
    seedAssistant?: boolean;
  } = {}) {
    let seq = 0;
    const entries: any[] = [];
    const appendUser = vi.fn(async (_conversationId: string, input: { id?: string; turnId: string; text: string }) => {
      const existing = entries.find((entry) => entry.kind === "user" && entry.turnId === input.turnId);
      if (existing) return existing;
      const entry = { seq: ++seq, id: input.id ?? `user:${input.turnId}`, kind: "user", turnId: input.turnId, revision: 1, payload: { text: input.text } };
      entries.push(entry);
      return entry;
    });
    const getChannelTurnState = vi.fn(async (_conversationId: string, input: { userTurnId: string; assistantTurnId: string }) => {
      const userEntry = entries.find((entry) => entry.kind === "user" && entry.turnId === input.userTurnId);
      if (!userEntry) return null;
      const assistantEntry = entries.find((entry) => entry.kind === "assistant" && entry.turnId === input.assistantTurnId && entry.seq > userEntry.seq);
      if (!assistantEntry) return { userEntry };
      const receipts = entries.filter((entry) => entry.kind === "delivery_receipt" && entry.payload.assistantTurnId === input.assistantTurnId && entry.seq > assistantEntry.seq);
      const latestReceipt = receipts.at(-1);
      return { userEntry, assistantEntry, ...(latestReceipt ? { latestReceipt } : {}) };
    });
    const appendDeliveryReceipt = vi.fn(async (_conversationId: string, input: { assistantTurnId: string; status: string; errorCode?: string; revision?: number }) => {
      if (options.failFinalReceipt && input.revision === 2) throw new Error("disk full");
      entries.push({ seq: ++seq, id: `receipt:${input.assistantTurnId}:r${input.revision}`, kind: "delivery_receipt", revision: input.revision, payload: { ...input } });
    });
    const assistantTurnId = makeChannelTurnId(makeIncoming({ messageId: "replay-1" }), "assistant");
    if (options.seedAssistant) {
      const userTurnId = makeChannelTurnId(makeIncoming({ messageId: "replay-1" }), "user");
      entries.push({ seq: ++seq, id: "seed-user", kind: "user", turnId: userTurnId, revision: 1, payload: { text: "已有用户" } });
      entries.push({ seq: ++seq, id: "seed-assistant", kind: "assistant", turnId: assistantTurnId, payload: { role: "assistant", content: "已有回复" } });
    }
    const journal = {
      appendUser,
      getChannelTurnState,
      appendPresentation: vi.fn(async () => undefined),
      buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: seq })),
      createRunSink: vi.fn((input: { assistantTurnId: string }) => ({
        appendAssistant: vi.fn(async () => {
          entries.push({ seq: ++seq, id: `assistant:${input.assistantTurnId}`, kind: "assistant", turnId: input.assistantTurnId, payload: { role: "assistant", content: "回复" } });
          return `assistant:${input.assistantTurnId}`;
        }),
        appendToolResult: vi.fn(async () => undefined),
        closeInterruption: vi.fn(async () => undefined),
        checkpoint: vi.fn(async () => undefined),
      })),
      appendDeliveryReceipt,
    };
    return { journal, entries, appendUser, getChannelTurnState, appendDeliveryReceipt };
  }

  it.each([
    ["delivered", { finalStatus: "delivered" as const }],
    ["failed", { finalStatus: "failed" as const }],
  ])("重复入站在 %s 最终回执后不再次执行或发送", async (_name, options) => {
    const replay = makeReplayJournal(options);
    const agent = vi.fn(async (_msg: IncomingMessage, input: { transcriptSink: { appendAssistant: () => Promise<string> } }) => {
      await input.transcriptSink.appendAssistant();
      return { text: "回复", sticker: null };
    });
    const delivery = vi.fn(async () => options.finalStatus === "delivered"
      ? { ok: true as const }
      : { ok: false as const, error: "offline" });
    const dispatcher = makeDispatcher({ journal: replay.journal as never, buildAndRunAgent: agent as never, delivery: { send: delivery } });
    const message = makeIncoming({ messageId: "replay-1" });

    await dispatcher.handleIncoming(message);
    await dispatcher.handleIncoming(message);

    expect(agent).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledOnce();
    expect(replay.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });

  it("重复入站遇到最终回执写失败时只保留未确认，不再次执行或发送", async () => {
    const replay = makeReplayJournal({ finalStatus: "delivered", failFinalReceipt: true });
    const agent = vi.fn(async (_msg: IncomingMessage, input: { transcriptSink: { appendAssistant: () => Promise<string> } }) => {
      await input.transcriptSink.appendAssistant();
      return { text: "回复", sticker: null };
    });
    const delivery = vi.fn(async () => ({ ok: true as const }));
    const dispatcher = makeDispatcher({ journal: replay.journal as never, buildAndRunAgent: agent as never, delivery: { send: delivery } });

    await dispatcher.handleIncoming(makeIncoming({ messageId: "replay-1" }));
    await dispatcher.handleIncoming(makeIncoming({ messageId: "replay-1" }));

    expect(agent).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledOnce();
    expect(replay.appendDeliveryReceipt).toHaveBeenCalledTimes(2);
  });

  it("已有 assistant 但没有 receipt 时只补 unconfirmed，不重跑或发送", async () => {
    const replay = makeReplayJournal({ seedAssistant: true });
    const agent = vi.fn(async () => ({ text: "不应执行", sticker: null }));
    const delivery = vi.fn(async () => ({ ok: true as const }));
    const dispatcher = makeDispatcher({ journal: replay.journal as never, buildAndRunAgent: agent as never, delivery: { send: delivery } });

    await dispatcher.handleIncoming(makeIncoming({ messageId: "replay-1" }));

    expect(agent).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(replay.appendDeliveryReceipt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      errorCode: "DELIVERY_UNCONFIRMED", revision: 1,
    }));
  });

  it("只有 user 轨迹时允许恢复一次模型处理", async () => {
    const replay = makeReplayJournal();
    const agent = vi.fn(async (_msg: IncomingMessage, input: { transcriptSink: { appendAssistant: () => Promise<string> } }) => {
      await input.transcriptSink.appendAssistant();
      return { text: "恢复", sticker: null };
    });
    const delivery = vi.fn(async () => ({ ok: true as const }));
    const dispatcher = makeDispatcher({ journal: replay.journal as never, buildAndRunAgent: agent as never, delivery: { send: delivery } });

    await dispatcher.handleIncoming(makeIncoming({ messageId: "replay-1" }));

    expect(agent).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledOnce();
    expect(replay.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });
});
