import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  handlers: new Map<string, (...args: any[]) => unknown>(),
  openPath: vi.fn(async () => ""),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
  },
  shell: {
    openPath: mocks.openPath,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

describe("chats IPC mode filtering", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.openPath.mockClear();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-ipc-"));
  });

  it("returns only Code sessions for CHATS_LIST({ mode: \"code\" })", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const list = mocks.handlers.get(IPC.CHATS_LIST);
    if (!create || !list) throw new Error("chat IPC handlers were not registered");
    const event = { sender: {} };

    await create(event, { mode: "chat" });
    await create(event, { mode: "work" });
    const code = await create(event, { mode: "code" }) as { id: string };

    expect(await list(event, { mode: "code" })).toEqual([
      expect.objectContaining({ id: code.id, mode: "code" }),
    ]);
  });

  it("writes a presentation checkpoint to the conversation journal", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const checkpoint = mocks.handlers.get(IPC.CTA_PRESENTATION_CHECKPOINT);
    if (!create || !checkpoint) throw new Error("presentation checkpoint IPC handler was not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await getConversationTranscriptStore(mocks.userDataDir).append(session.id, {
      id: "assistant-1",
      at: 1,
      kind: "assistant",
      payload: { role: "assistant", content: "draft" },
    });

    await expect(checkpoint(event, {
      sessionId: session.id,
      messageId: "assistant-1",
      mutationKey: "run:checkpoint-1",
      patch: { content: "final", toolExecutions: [] },
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    const snapshot = await getConversationTranscriptStore(mocks.userDataDir).read(session.id);
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "presentation_patch",
        payload: expect.objectContaining({ messageId: "assistant-1", patchRevision: 1, mutationKey: "run:checkpoint-1" }),
      }),
    ]));
  });

  it("routes CHATS_COMPACT through the transcript compactor checkpoint protocol", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    const { ConversationTranscriptCompactor } = await import("../orchestrator/conversation-transcript-compactor");
    const store = getConversationTranscriptStore(mocks.userDataDir);
    const compactor = new ConversationTranscriptCompactor({
      store,
      summarize: async () => "会话摘要",
    });
    registerChatsIpc(undefined, { transcriptCompactor: compactor });
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const compact = mocks.handlers.get(IPC.CHATS_COMPACT);
    if (!create || !compact) throw new Error("compaction IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string; messages: unknown[] };
    await store.append(session.id, {
      id: "compact-u1", at: 1, kind: "user", turnId: "u1", revision: 1,
      payload: { text: "旧上下文".repeat(30) },
    });
    await store.append(session.id, {
      id: "compact-u2", at: 1, kind: "user", turnId: "u2", revision: 1,
      payload: { text: "最新问题" },
    });

    await expect(compact(event, { sessionId: session.id, retainTokens: 1 })).resolves.toEqual(
      expect.objectContaining({ ok: true, sourceThroughSeq: 1 }),
    );
    expect((await store.read(session.id)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "compaction_checkpoint" }),
    ]));
    expect(session.messages).toEqual([]);
  });

  it("normalizes a manual summarizer failure to TRANSCRIPT_COMPACTION_REQUIRED", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc(undefined, {
      transcriptCompactor: { compact: vi.fn(async () => { throw new Error("provider down"); }) } as any,
    });
    const compact = mocks.handlers.get(IPC.CHATS_COMPACT);
    if (!compact) throw new Error("compaction IPC handler was not registered");
    await expect(compact({ sender: {} }, { sessionId: "c1" })).resolves.toEqual({
      ok: false, error: "TRANSCRIPT_COMPACTION_REQUIRED",
    });
  });

  it("runs the controller through the real bridge handler before api.run and fails closed for a deep patch", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    const { AgentRunController } = await import("../../renderer/react/features/chat/pages/run/AgentRunController");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const checkpoint = mocks.handlers.get(IPC.CTA_PRESENTATION_CHECKPOINT);
    if (!create || !checkpoint) throw new Error("controller bridge handlers were not registered");
    vi.stubGlobal("window", { chat: undefined, setTimeout, clearTimeout });
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string };
    const transcript = getConversationTranscriptStore(mocks.userDataDir);
    await transcript.append(session.id, {
      id: "assistant-controller",
      at: 1,
      kind: "assistant",
      payload: { role: "assistant", content: "" },
    });
    const listeners = new Set<(value: { type: string; runId: string; result?: { status: string } }) => void>();
    const api = {
      run: vi.fn(async () => {
        expect((await transcript.readProjection(session.id)).messages.find((message) => message.id === "assistant-controller")?.runSnapshot?.status)
          .toBe("running");
        setTimeout(() => {
          const started = { type: "RUN_STARTED", runId: "run-controller" };
          const finished = { type: "RUN_FINISHED", runId: "run-controller", result: { status: "success" } };
          for (const listener of listeners) listener(started);
          for (const listener of listeners) listener(finished);
        }, 0);
        return { success: true, runId: "run-controller" };
      }),
      onEvent: vi.fn((listener: (value: { type: string; runId: string; result?: { status: string } }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      cancel: vi.fn(async () => undefined),
      reportRunPersisted: vi.fn(),
    };
    const makeDeps = (store: { checkpointPresentation: (...args: any[]) => Promise<unknown> }, run: ReturnType<typeof vi.fn>) => ({
      api: { ...api, run },
      store,
      host: {
        patchMessage: vi.fn(), setInteraction: vi.fn(), clearInteraction: vi.fn(), dismissAskIfMatched: vi.fn(),
        updateTodos: vi.fn(), updateContextUsage: vi.fn(), setCompressingContext: vi.fn(), setModeBusy: vi.fn(),
        requestTakeover: vi.fn(), clearTakeover: vi.fn(), earlyTts: { start: vi.fn(() => ({ cancel: vi.fn() })), finish: vi.fn() },
        onRunFinished: vi.fn(),
      },
      registries: {
        activeRuns: { current: {} }, checkpointTriggers: { current: {} },
        cancelRequestedSessions: { current: new Set<string>() }, eventUnsubscribers: { current: new Set<() => void>() },
      },
      startRun: vi.fn(async () => undefined),
    });
    const input = {
      targetMode: "chat", sessionId: session.id, userMessageId: "user-controller", assistantId: "assistant-controller",
      session: { id: session.id, messages: [{ id: "user-controller", role: "user", content: "hello", at: 1 }] }, attachments: [],
    } as any;
    const validStore = { checkpointPresentation: async (...args: any[]) => checkpoint(event, {
      sessionId: args[0], messageId: args[1], mutationKey: args[2], patch: args[3],
    }) };
    await new AgentRunController(input, makeDeps(validStore, api.run) as any).start();
    expect(api.run).toHaveBeenCalledTimes(1);

    const invalidRun = vi.fn(async () => ({ success: true, runId: "never-started" }));
    await transcript.append(session.id, {
      id: "assistant-invalid",
      at: 1,
      kind: "assistant",
      payload: { role: "assistant", content: "" },
    });
    let firstCheckpoint = true;
    const failClosedStore = { checkpointPresentation: async (...args: any[]) => checkpoint(event, {
      sessionId: args[0], messageId: args[1], mutationKey: args[2],
      patch: firstCheckpoint ? (firstCheckpoint = false, { runSnapshot: {} }) : args[3],
    }) };
    const invalidController = new AgentRunController({ ...input, assistantId: "assistant-invalid" }, makeDeps(failClosedStore, invalidRun) as any);
    await expect(invalidController.start()).rejects.toThrow("invalid-presentation-patch");
    expect(invalidRun).not.toHaveBeenCalled();
  });

  it("accepts a TTS cache update as a presentation-only patch", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const checkpoint = mocks.handlers.get(IPC.CTA_PRESENTATION_CHECKPOINT);
    if (!create || !checkpoint) throw new Error("presentation checkpoint IPC handler was not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string };
    const transcript = getConversationTranscriptStore(mocks.userDataDir);
    await transcript.append(session.id, {
      id: "assistant-tts",
      at: 1,
      kind: "assistant",
      payload: { role: "assistant", content: "你好" },
    });

    await expect(checkpoint(event, {
      sessionId: session.id,
      messageId: "assistant-tts",
      mutationKey: "tts:minimax-key:v1",
      patch: { ttsCacheKey: "minimax-key", ttsCacheVersion: "v1" },
    })).resolves.toEqual({ ok: true });
    const patchEntry = (await transcript.read(session.id)).entries.at(-1);
    expect(patchEntry).toEqual(expect.objectContaining({
      kind: "presentation_patch",
      payload: { messageId: "assistant-tts", patchRevision: 1, mutationKey: "tts:minimax-key:v1", patch: { ttsCacheKey: "minimax-key", ttsCacheVersion: "v1" } },
    }));
  });

  it("fails closed for unknown or empty presentation fields without touching disk", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const checkpoint = mocks.handlers.get(IPC.CTA_PRESENTATION_CHECKPOINT);
    if (!create || !checkpoint) throw new Error("presentation checkpoint IPC handler was not registered");
    const session = await create({ sender: {} }, { mode: "chat" }) as { id: string };
    const transcript = getConversationTranscriptStore(mocks.userDataDir);
    await transcript.append(session.id, { id: "assistant-invalid", at: 1, kind: "assistant", payload: { role: "assistant", content: "draft" } });
    await expect(checkpoint({ sender: {} }, {
      sessionId: session.id, messageId: "assistant-invalid", mutationKey: "invalid:unknown",
      patch: { answersUserMessageId: "u1" },
    })).resolves.toEqual({ ok: false, error: "invalid-presentation-patch" });
    await expect(checkpoint({ sender: {} }, {
      sessionId: session.id, messageId: "assistant-invalid", mutationKey: "invalid:empty", patch: {},
    })).resolves.toEqual({ ok: false, error: "invalid-presentation-patch" });
    expect((await transcript.read(session.id)).entries.filter((entry) => entry.kind === "presentation_patch")).toHaveLength(0);
  });

  it("先迁移再从轨迹 projection 组合 CHATS_GET 与 CHATS_GET_PAGE", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const get = mocks.handlers.get(IPC.CHATS_GET);
    const getPage = mocks.handlers.get(IPC.CHATS_GET_PAGE);
    if (!create || !get || !getPage) throw new Error("chat IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    const transcript = (await import("../orchestrator/conversation-transcript-store")).getConversationTranscriptStore(mocks.userDataDir);
    await transcript.append(session.id, { id: "u1", kind: "user", turnId: "u1", revision: 1, at: 1, payload: { text: "hello" } });
    await transcript.append(session.id, { id: "a1", kind: "assistant", at: 2, payload: { role: "assistant", content: "world" } });

    const full = await get(event, session.id) as { schemaVersion: number; messages: Array<{ id: string }> };
    expect(full.schemaVersion).toBe(1);
    expect(full.messages.map((message) => message.id)).toEqual(["u1", "a1"]);

    const page = await getPage(event, { id: session.id, limit: 1 }) as {
      session: { messageCount: number };
      messages: Array<{ id: string }>;
      hasMore: boolean;
      nextBefore: number | null;
    };
    expect(page.session.messageCount).toBe(2);
    expect(page.messages.map((message) => message.id)).toEqual(["a1"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe(1);

    const firstPage = await getPage(event, { id: session.id, before: 1, limit: 1 }) as {
      session: { messageCount: number };
      messages: Array<{ id: string }>;
      nextBefore: number | null;
    };
    expect(firstPage.session.messageCount).toBe(2);
    expect(firstPage.messages.map((message) => message.id)).toEqual(["u1"]);
    expect(firstPage.nextBefore).toBeNull();
  });

  it("schedules first-message title generation for every conversation mode with visible text only", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const scheduled: Array<{ sessionId: string; userMessageId: string; text: string }> = [];
    registerChatsIpc(undefined, {
      titleService: {
        schedule: (input) => {
          scheduled.push(input);
          return true;
        },
      },
    });

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const claim = mocks.handlers.get(IPC.CHATS_PENDING_CLAIM);
    if (!create || !enqueue || !claim) throw new Error("title generation IPC handlers were not registered");
    const event = { sender: {} };

    for (const mode of ["chat", "work", "code", "learn"] as const) {
      const created = await create(event, { mode }) as { id: string };
      await enqueue(event, {
        sessionId: created.id,
        entry: {
          id: `first-${mode}`,
          rawContent: `处理${mode}问题[sticker:wave]`,
          visibleContent: `处理${mode}问题`,
          attachments: [{ kind: "document", name: "notes.txt", filePath: "C:\\tmp\\notes.txt" }],
          enqueuedAt: 1,
        },
      });
      await claim(event, created.id);
    }

    expect(scheduled).toEqual([
      expect.objectContaining({ userMessageId: "first-chat", text: "处理chat问题" }),
      expect.objectContaining({ userMessageId: "first-work", text: "处理work问题" }),
      expect.objectContaining({ userMessageId: "first-code", text: "处理code问题" }),
      expect.objectContaining({ userMessageId: "first-learn", text: "处理learn问题" }),
    ]);
  });

  it("pending remove 先写 journal 墓碑，不能绕过轨迹直接删除", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const remove = mocks.handlers.get(IPC.CHATS_PENDING_REMOVE);
    if (!create || !enqueue || !remove) throw new Error("pending withdrawal IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    const transcript = getConversationTranscriptStore(mocks.userDataDir);
    await transcript.append(session.id, {
      id: "canonical-p1",
      at: 1,
      kind: "user",
      turnId: "p1",
      revision: 1,
      payload: { text: "待撤回" },
    });
    await enqueue(event, {
      sessionId: session.id,
      entry: { id: "p1", rawContent: "待撤回", visibleContent: "待撤回" },
    });

    expect(await remove(event, { sessionId: session.id, messageId: "p1" })).toEqual({ ok: true, removed: true });
    expect((await transcript.read(session.id)).entries).toEqual([
      expect.objectContaining({ kind: "user", id: "canonical-p1" }),
      expect.objectContaining({
        kind: "turn_tombstone",
        payload: { targetUserTurnId: "p1", reason: "pending_withdrawn" },
      }),
    ]);
    expect(await remove(event, { sessionId: session.id, messageId: "p1" })).toEqual({ ok: true, removed: false });
  });

  it("does not register the removed Cline plan/act IPC", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const setCodeMode = mocks.handlers.get("chats:set-code-mode");
    expect(setCodeMode).toBeUndefined();
  });

  it("removes only the deleted conversation's persisted tool results", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { FileToolOutputStore } = await import("../orchestrator/harness/tool-output/file-tool-output-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const remove = mocks.handlers.get(IPC.CHATS_DELETE);
    if (!create || !remove) throw new Error("chat delete IPC handler was not registered");
    const event = { sender: {} };
    const first = await create(event, { mode: "work" }) as { id: string };
    const second = await create(event, { mode: "work" }) as { id: string };
    const store = new FileToolOutputStore(mocks.userDataDir);
    const firstRef = await store.put({
      conversationId: first.id, runId: "run-1", toolCallId: "call-1", toolName: "read_file",
      outcome: "success", output: "first output", truncatedForModel: false,
    });
    const secondRef = await store.put({
      conversationId: second.id, runId: "run-2", toolCallId: "call-2", toolName: "read_file",
      outcome: "success", output: "second output", truncatedForModel: false,
    });

    expect(await remove(event, first.id)).toBe(true);
    await expect(store.read({ conversationId: first.id, resultRef: firstRef.resultRef, offset: 0, length: 100 }))
      .resolves.toBeNull();
    await expect(store.read({ conversationId: second.id, resultRef: secondRef.resultRef, offset: 0, length: 100 }))
      .resolves.toMatchObject({ content: "second output" });
  });

  it("removes only the deleted conversation's transcript directory", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const remove = mocks.handlers.get(IPC.CHATS_DELETE);
    if (!create || !remove) throw new Error("chat delete IPC handler was not registered");
    const event = { sender: {} };
    const first = await create(event, { mode: "work" }) as { id: string };
    const second = await create(event, { mode: "work" }) as { id: string };
    const store = getConversationTranscriptStore(mocks.userDataDir);
    // 两个会话各写一条 user 轨迹（user 条目必带 turnId + revision 幂等键）
    await store.append(first.id, {
      id: "tr-user-1", at: 1, kind: "user", turnId: "turn-1", revision: 1,
      payload: { text: "first conversation" },
    });
    await store.append(second.id, {
      id: "tr-user-2", at: 1, kind: "user", turnId: "turn-2", revision: 1,
      payload: { text: "second conversation" },
    });

    expect(await remove(event, first.id)).toBe(true);
    // 第一个会话的轨迹目录被整体删除（JSONL 与快照一起消失），读取回到空轨迹
    expect(fs.existsSync(path.join(mocks.userDataDir, first.id))).toBe(false);
    expect((await store.read(first.id)).entries).toEqual([]);
    // 第二个会话的轨迹不受影响，仍然可读
    const remaining = await store.read(second.id);
    expect(remaining.entries).toEqual([expect.objectContaining({ id: "tr-user-2" })]);
  });

  it("opens only a workspace already bound to a project conversation", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setWorkspace = mocks.handlers.get(IPC.CHATS_SET_WORKSPACE);
    const openWorkspace = mocks.handlers.get(IPC.CHATS_OPEN_WORKSPACE);
    if (!create || !setWorkspace || !openWorkspace) {
      throw new Error("workspace IPC handlers were not registered");
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-workspace-"));
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-unrelated-"));
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await setWorkspace(event, { sessionId: session.id, workspaceRoot });

    expect(await openWorkspace(event, unrelatedRoot)).toEqual({
      ok: false,
      error: "workspace is not bound to a conversation",
    });
    expect(mocks.openPath).not.toHaveBeenCalled();

    expect(await openWorkspace(event, workspaceRoot)).toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledOnce();
    expect(mocks.openPath).toHaveBeenCalledWith(fs.realpathSync(workspaceRoot));
  });
});
