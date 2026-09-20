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

  it("validates and forwards CHATS_UPSERT for run checkpoints", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const upsert = mocks.handlers.get(IPC.CHATS_UPSERT);
    if (!create || !upsert) throw new Error("checkpoint IPC handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };

    expect(await upsert(event, null)).toBeNull();
    expect(await upsert(event, { id: session.id })).toBeNull();
    expect(await upsert(event, {
      id: session.id,
      message: { id: "assistant-1", role: "model", content: "checkpoint", at: 1 },
    })).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ id: "assistant-1", content: "checkpoint" })],
    }));
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

  it("also schedules legacy direct appends without sticker markers or attachments", async () => {
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

    await append(event, {
      id: created.id,
      message: {
        id: "legacy-first",
        role: "user",
        content: "  总结这份材料 [sticker:wave]  ",
        at: 1,
        attachments: [{ kind: "document", name: "secret.txt", filePath: "C:\\tmp\\secret.txt", status: "pending" }],
      },
    });

    expect(scheduled).toEqual([{
      sessionId: created.id,
      userMessageId: "legacy-first",
      text: "总结这份材料",
    }]);
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
