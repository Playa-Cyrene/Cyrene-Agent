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

  it("returns a stable retired error for formal message IPC", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();
    const retired = [IPC.CHATS_APPEND, IPC.CHATS_UPSERT, IPC.CHATS_SET_MESSAGE_TTS_CACHE, IPC.CHATS_REPLACE_MESSAGES, IPC.CHATS_REPLACE_TAIL];
    const transcriptDir = path.join(mocks.userDataDir, "transcripts");
    const before = fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).sort() : [];
    for (const channel of retired) {
      const handler = mocks.handlers.get(channel);
      if (!handler) throw new Error(`retired message IPC handler missing: ${channel}`);
      expect(await handler({ sender: {} }, { id: "session-1", message: { id: "m1" } }))
        .toEqual({ ok: false, error: "chat-message-store-retired" });
    }
    const after = fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).sort() : [];
    expect(after).toEqual(before);
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

  it("validates and forwards CHATS_UPSERT for run checkpoints", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const upsert = mocks.handlers.get(IPC.CHATS_UPSERT);
    if (!create || !upsert) throw new Error("checkpoint IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };

    expect(await upsert(event, null)).toEqual({ ok: false, error: "chat-message-store-retired" });
    expect(await upsert(event, { id: session.id })).toEqual({ ok: false, error: "chat-message-store-retired" });
    expect(await upsert(event, {
      id: session.id,
      message: { id: "assistant-1", role: "model", content: "checkpoint", at: 1 },
    })).toEqual({ ok: false, error: "chat-message-store-retired" });
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

  it("retires legacy direct appends without writing metadata", async () => {
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
    const append = mocks.handlers.get(IPC.CHATS_APPEND);
    if (!create || !append) throw new Error("direct append IPC handlers were not registered");
    const event = { sender: {} };
    const created = await create(event, { mode: "chat" }) as { id: string };

    expect(await append(event, {
      id: created.id,
      message: {
        id: "legacy-first",
        role: "user",
        content: "  总结这份材料 [sticker:wave]  ",
        at: 1,
        attachments: [{ kind: "document", name: "secret.txt", filePath: "C:\\tmp\\secret.txt", status: "pending" }],
      },
    })).toEqual({ ok: false, error: "chat-message-store-retired" });
    expect(scheduled).toEqual([]);
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
