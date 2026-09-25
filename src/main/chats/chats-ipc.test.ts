import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  handlers: new Map<string, (...args: any[]) => unknown>(),
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
  },
  shell: {
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder,
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
    mocks.showItemInFolder.mockClear();
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

  it("CHATS_SET_WORKSPACE：最近项目记录的目录已不存在时绑定被拒绝且不落库", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setWorkspace = mocks.handlers.get(IPC.CHATS_SET_WORKSPACE);
    const getWorkspace = mocks.handlers.get(IPC.CHATS_GET_WORKSPACE);
    if (!create || !setWorkspace || !getWorkspace) {
      throw new Error("workspace IPC handlers were not registered");
    }

    const event = { sender: {} };
    const session = await create(event, { mode: "code" }) as { id: string };
    // 场景：最近项目下拉选了历史路径，但该目录已被移动/删除/外接盘断开
    const goneRoot = path.join(
      os.tmpdir(),
      `cyrene-gone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    // 绑定必须失败并带出可读错误，而不是静默丢掉
    const result = await setWorkspace(event, { sessionId: session.id, workspaceRoot: goneRoot });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("目录不存在") });
    // 绑定未写入：后续派发会被 AGUI_RUN 的"需先绑定工作区"守卫拒绝
    expect(await getWorkspace(event, session.id)).toBeNull();
  });

  it("CHATS_SET_WORKSPACE：组合读取迁移成 v2 的会话仍可绑定（session not found 回归）", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const getSession = mocks.handlers.get(IPC.CHATS_GET);
    const setWorkspace = mocks.handlers.get(IPC.CHATS_SET_WORKSPACE);
    const getWorkspace = mocks.handlers.get(IPC.CHATS_GET_WORKSPACE);
    if (!create || !getSession || !setWorkspace || !getWorkspace) {
      throw new Error("workspace IPC handlers were not registered");
    }

    const event = { sender: {} };
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-ws-v2-"));
    const session = await create(event, { mode: "code" }) as { id: string };

    // 复现真实时序：ensureSession → selectSession 先用 store.get（组合读取）把
    // 刚创建的 v1 会话迁移成 v2 落盘，随后 sendMessage 的 setWorkspace 才到达。
    // 只认 v1 的 getSession 会把该会话误判成 "session not found"，绑定静默失败，
    // 消息照发后被派发守卫拒绝——即"选了工作区却提示未绑定"的原始 bug
    expect(await getSession(event, session.id)).not.toBeNull();
    const { getSessionRecord } = await import("./chats-store");
    expect(getSessionRecord(session.id)?.schemaVersion).toBe(2);

    // v2 会话绑定必须成功且落库
    const result = await setWorkspace(event, { sessionId: session.id, workspaceRoot });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(await getWorkspace(event, session.id)).toEqual(
      expect.objectContaining({ workspaceRoot: fs.realpathSync(workspaceRoot) }),
    );
  });

  it("CHATS_VALIDATE_WORKSPACE：目录存在返回规范化路径，失效目录带出可读错误", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const validate = mocks.handlers.get(IPC.CHATS_VALIDATE_WORKSPACE);
    if (!validate) throw new Error("workspace validation IPC handler was not registered");

    const event = { sender: {} };
    // 可用目录：通过并返回真实绝对路径（realpath 解析）
    const goodRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-valid-ws-"));
    const good = await validate(event, goodRoot);
    expect(good).toEqual({ ok: true, path: fs.realpathSync(goodRoot) });

    // 失效目录（最近项目快照过期/外接盘断开）：明确失败而不是放行
    const goneRoot = path.join(
      os.tmpdir(),
      `cyrene-gone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const gone = await validate(event, goneRoot);
    expect(gone).toEqual({ ok: false, error: expect.stringContaining("目录不存在") });

    // 非法入参直接拒绝
    expect(await validate(event, "")).toEqual({ ok: false, error: "missing workspaceRoot" });
  });

  it("CHATS_SHELL_FILE：打开/定位工作区内文件；未绑定、非法参数、越界、缺失文件各自拒绝", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setWorkspace = mocks.handlers.get(IPC.CHATS_SET_WORKSPACE);
    const shellFile = mocks.handlers.get(IPC.CHATS_SHELL_FILE);
    if (!create || !setWorkspace || !shellFile) {
      throw new Error("shell file IPC handlers were not registered");
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-workspace-"));
    fs.writeFileSync(path.join(workspaceRoot, "a.txt"), "hello");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await setWorkspace(event, { sessionId: session.id, workspaceRoot });
    // realpathSync.native 与主进程 fs.promises.realpath 同为 native 实现：
    // 会把 Windows 8.3 短路径（CI runner 的 RUNNER~1）展开成长路径，断言两边才一致
    const absFile = path.join(fs.realpathSync.native(workspaceRoot), "a.txt");

    // 未绑定工作区的会话 → NO_WORKSPACE，不碰 shell
    const plain = await create(event, { mode: "chat" }) as { id: string };
    await expect(shellFile(event, { sessionId: plain.id, relPath: "a.txt", action: "open" }))
      .resolves.toEqual({ ok: false, error: "NO_WORKSPACE" });

    // 非法 action / 空 relPath → invalid-payload
    await expect(shellFile(event, { sessionId: session.id, relPath: "a.txt", action: "exec" }))
      .resolves.toEqual({ ok: false, error: "invalid-payload" });
    await expect(shellFile(event, { sessionId: session.id, relPath: "", action: "open" }))
      .resolves.toEqual({ ok: false, error: "invalid-payload" });

    // 工作区内文件：open → shell.openPath(真实绝对路径)
    expect(await shellFile(event, { sessionId: session.id, relPath: "a.txt", action: "open" })).toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith(absFile);

    // reveal → shell.showItemInFolder(真实绝对路径)
    expect(await shellFile(event, { sessionId: session.id, relPath: "a.txt", action: "reveal" })).toEqual({ ok: true });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(absFile);

    // ".." 逃逸到工作区外 → OUT_OF_ROOT
    await expect(shellFile(event, { sessionId: session.id, relPath: "..", action: "open" }))
      .resolves.toEqual({ ok: false, error: "OUT_OF_ROOT" });
    expect(mocks.openPath).toHaveBeenCalledTimes(1);

    // 已删除文件 → NOT_FOUND（FileChangeCard 里 kind=deleted 的预期路径）
    await expect(shellFile(event, { sessionId: session.id, relPath: "missing.txt", action: "open" }))
      .resolves.toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("CHATS_SHELL_FILE：绝对路径模式（正文文件链接）支持工作区外文件，不存在则拒绝", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const shellFile = mocks.handlers.get(IPC.CHATS_SHELL_FILE);
    if (!create || !shellFile) {
      throw new Error("shell file IPC handlers were not registered");
    }

    // 工作区外的真实文件（临时目录模拟"桌面文件"场景）
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-outside-"));
    const outsideFile = path.join(outsideDir, "nop-60s.cmd");
    fs.writeFileSync(outsideFile, "echo hi");

    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };

    // 工作区外的绝对路径也能 open/reveal（realpath 归一后交给 shell）
    expect(await shellFile(event, { sessionId: session.id, relPath: outsideFile, action: "open" })).toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith(fs.realpathSync.native(outsideFile));
    expect(await shellFile(event, { sessionId: session.id, relPath: outsideFile, action: "reveal" })).toEqual({ ok: true });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(fs.realpathSync.native(outsideFile));

    // 正斜杠形式的绝对路径（file:/// 链接解析出的形态）同样支持
    expect(await shellFile(event, { sessionId: session.id, relPath: outsideFile.replaceAll("\\", "/"), action: "open" }))
      .toEqual({ ok: true });

    // 不存在的绝对路径 → NOT_FOUND
    await expect(shellFile(event, { sessionId: session.id, relPath: path.join(outsideDir, "missing.cmd"), action: "open" }))
      .resolves.toEqual({ ok: false, error: "NOT_FOUND" });
  });

  // ── 会话级模型状态（Invariant B/D 的 IPC 层）──────────────────
  // 预置带 A/B 两个档案的 model-settings.json，让真实 loadModelSettings 读到。
  function writeModelSettings(profiles: unknown[], defaultId: string) {
    fs.writeFileSync(path.join(mocks.userDataDir, "model-settings.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      provider: "GLM（智谱）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.3",
      apiKey: "sk-test",
      explicitTransport: "openai",
      perProvider: {},
      modelProfiles: profiles,
      defaultModelProfileId: defaultId,
      runtimeSync: "off",
      stickerEnabled: true,
      stickerSize: "standard",
      stickerSimilarityThreshold: 0.55,
      chatRequestTimeoutSec: 300,
      citaRepairBudgetSec: 8,
      rerankerMode: "standard",
      embeddingModel: "bgem3",
      multimodal: true,
      contextWindowTokens: 256000,
    }));
  }

  // A 多模型（默认 glm-x + 子模型 glm-a2）；B 默认 glm-b1，清单里带同名 glm-x
  const PROFILE_A = {
    id: "p-a", provider: "GLM（智谱）", baseUrl: "https://a.example", apiKey: "sk-a",
    model: "glm-x", models: ["glm-x", "glm-a2"],
  };
  const PROFILE_B = {
    id: "p-b", provider: "GLM（智谱）", baseUrl: "https://b.example", apiKey: "sk-b",
    model: "glm-b1", models: ["glm-b1", "glm-x"],
  };

  it("#16 CHATS_CREATE 创建即快照默认模型；CHATS_SET_MODEL_PROFILE 原子重置为新档案默认", async () => {
    writeModelSettings([PROFILE_A, PROFILE_B], "p-a");
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setSessionModel = mocks.handlers.get(IPC.CHATS_SET_SESSION_MODEL);
    const setProfile = mocks.handlers.get(IPC.CHATS_SET_MODEL_PROFILE);
    if (!create || !setSessionModel || !setProfile) {
      throw new Error("model state IPC handlers were not registered");
    }
    const event = { sender: {} };

    // 创建即快照：绑定 + 模型 = 默认档案（p-a）的默认模型
    const session = await create(event, { mode: "chat" }) as {
      id: string; modelProfileId?: string; model?: string;
    };
    expect(session).toMatchObject({ modelProfileId: "p-a", model: "glm-x" });

    // 会话切到 A 的子模型，再切档案 B → 模型原子重置为 B 默认（不继承子模型选择）
    await expect(setSessionModel(event, { id: session.id, model: "glm-a2" })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    const switched = await setProfile(event, { id: session.id, modelProfileId: "p-b" }) as {
      modelProfileId?: string;
      model?: string;
    };
    expect(switched).toMatchObject({ modelProfileId: "p-b", model: "glm-b1" });
  });

  it("#17 A 与 B 清单含同名模型：切 B 仍取 B 默认，同名不继承", async () => {
    writeModelSettings([PROFILE_A, PROFILE_B], "p-a");
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const setProfile = mocks.handlers.get(IPC.CHATS_SET_MODEL_PROFILE);
    if (!create || !setProfile) throw new Error("model state IPC handlers were not registered");
    const event = { sender: {} };

    // 创建即快照 A 默认 glm-x；glm-x 同时也在 B 清单里——切档案必须取 B 默认
    const session = await create(event, { mode: "chat" }) as { id: string; model?: string };
    expect(session.model).toBe("glm-x");
    const switched = await setProfile(event, { id: session.id, modelProfileId: "p-b" }) as {
      model?: string;
    };
    expect(switched.model).toBe("glm-b1");
  });

  it("#24 stale 绑定下主动选择 → 原子修复为回退档案 + 选中模型", async () => {
    writeModelSettings([PROFILE_A, PROFILE_B], "p-a");
    const { registerChatsIpc } = await import("./chats-ipc");
    const chatsStore = await import("./chats-store");
    registerChatsIpc();
    chatsStore.initialize();
    const setSessionModel = mocks.handlers.get(IPC.CHATS_SET_SESSION_MODEL);
    if (!setSessionModel) throw new Error("session model IPC handler was not registered");
    const event = { sender: {} };

    // 直建绑定失效的会话（绑定的档案不存在）；主动选择 = 确认接受回退档案 p-a
    const session = chatsStore.createSession({ modelProfileId: "p-deleted", model: "glm-a2" });
    await expect(setSessionModel(event, { id: session.id, model: "glm-a2" })).resolves.toEqual({
      ok: true,
      session: expect.objectContaining({ modelProfileId: "p-a", model: "glm-a2" }),
    });
    expect(chatsStore.getSessionRecord(session.id)).toMatchObject({
      modelProfileId: "p-a",
      model: "glm-a2",
    });
  });

  it("validator 无旁门：回退档案清单之外的模型一律拒绝，会话保持原状", async () => {
    writeModelSettings([PROFILE_A, PROFILE_B], "p-a");
    const { registerChatsIpc } = await import("./chats-ipc");
    const chatsStore = await import("./chats-store");
    registerChatsIpc();
    chatsStore.initialize();
    const setSessionModel = mocks.handlers.get(IPC.CHATS_SET_SESSION_MODEL);
    if (!setSessionModel) throw new Error("session model IPC handler was not registered");
    const event = { sender: {} };

    const session = chatsStore.createSession({ modelProfileId: "p-deleted", model: "glm-a2" });
    // glm-b1 只存在于非回退档案 B → 拒绝（窄 IPC 不留 free-form 旁门）
    await expect(setSessionModel(event, { id: session.id, model: "glm-b1" })).resolves.toEqual({
      ok: false,
      error: "invalid-model",
    });
    expect(chatsStore.getSessionRecord(session.id)).toMatchObject({
      modelProfileId: "p-deleted",
      model: "glm-a2",
    });
  });

  it("CHATS_SET_SESSION_MODEL 入参校验：空模型 → invalid-payload；会话不存在 → session-not-found", async () => {
    writeModelSettings([PROFILE_A], "p-a");
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const setSessionModel = mocks.handlers.get(IPC.CHATS_SET_SESSION_MODEL);
    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    if (!setSessionModel || !create) throw new Error("session model IPC handlers were not registered");
    const event = { sender: {} };

    const session = await create(event, { mode: "chat" }) as { id: string };
    await expect(setSessionModel(event, { id: session.id, model: "" })).resolves.toEqual({
      ok: false,
      error: "invalid-payload",
    });
    await expect(setSessionModel(event, { model: "glm-x" })).resolves.toEqual({
      ok: false,
      error: "invalid-payload",
    });
    await expect(setSessionModel(event, { id: "missing", model: "glm-x" })).resolves.toEqual({
      ok: false,
      error: "session-not-found",
    });
  });
});
