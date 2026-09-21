import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { prepareTranscriptDispatch } from "./conversation-transcript-coordinator";
import type { ChatSession } from "../../shared/chat-types";

// ── 测试夹具 ─────────────────────────────────────────────

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-coord-"));
  roots.push(root);
  return { root, store: new ConversationTranscriptStore(root, { now: () => 1_000 }) };
}

function makeSession(overrides?: Partial<ChatSession>): ChatSession {
  return {
    id: "c1",
    title: "测试会话",
    identityId: null,
    createdAt: 1,
    updatedAt: 5,
    schemaVersion: 1,
    messages: [
      { id: "m1", role: "user", content: "旧问题", at: 1 },
      {
        id: "m2",
        role: "model",
        content: "旧回答",
        at: 2,
        // 带 UI 工具卡：回填只存纯文本，不捏造旧工具历史
        toolExecutions: [{ id: "t1", name: "read_file", status: "success", result: "预览" }],
      },
      { id: "u-current", role: "user", content: "当前输入", at: 3 },
    ],
    ...overrides,
  };
}

/** 旧消息的确定性回填 entryId。 */
function legacyEntryId(messageId: string): string {
  return `backfill:v1:${messageId}`;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prepareTranscriptDispatch", () => {
  it("backfills legacy history, writes boundary, then appends current user exactly once", async () => {
    const { store } = createStore();
    const session = makeSession();
    await prepareTranscriptDispatch({ store, session, userTurnId: "u-current", runId: "run-1" });
    // IPC 重试：同一 dispatch 重复到达，必须幂等
    await prepareTranscriptDispatch({ store, session, userTurnId: "u-current", runId: "run-1" });

    const entries = (await store.read(session.id)).entries;
    expect(entries.filter((entry) => entry.kind === "backfill_boundary")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "user" && entry.turnId === "u-current")).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === "user" && entry.turnId === "u-current")?.seq)
      .toBeGreaterThan(entries.find((entry) => entry.kind === "backfill_boundary")!.seq);

    // 旧 model 消息只回填纯文本 content，不捏造工具历史
    const backfilledAssistant = entries.find((entry) => entry.kind === "assistant");
    expect(backfilledAssistant?.payload).toEqual({ role: "assistant", content: "旧回答" });
  });

  it("resumes a partially written backfill before creating the boundary", async () => {
    const { store } = createStore();
    const session = makeSession();
    // 模拟崩溃遗留：第一条旧消息的回填行已在盘上
    await store.append("c1", {
      id: legacyEntryId(session.messages[0]!.id),
      at: session.messages[0]!.at,
      kind: "user",
      turnId: session.messages[0]!.id,
      revision: 1,
      payload: { text: "旧问题" },
    });
    await prepareTranscriptDispatch({ store, session, userTurnId: "u-current", runId: "run-1" });

    const entries = (await store.read("c1")).entries;
    expect(entries.filter((entry) => entry.id === legacyEntryId(session.messages[0]!.id))).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "backfill_boundary")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "user" && entry.turnId === "u-current")).toHaveLength(1);
  });

  it("writes edit as one replace_user row and regenerate as one keep_user row", async () => {
    const { store } = createStore();
    const editedSession = makeSession({
      messages: [
        { id: "m1", role: "user", content: "旧问题", at: 1 },
        { id: "m2", role: "model", content: "旧回答", at: 2 },
        { id: "u1", role: "user", content: "edited", at: 3 },
      ],
    });
    await prepareTranscriptDispatch({
      store, session: editedSession, userTurnId: "u1", runId: "run-edit",
      rewind: { anchorUserTurnId: "u1", disposition: "replace_user" },
    });
    await prepareTranscriptDispatch({
      store, session: editedSession, userTurnId: "u1", runId: "run-regen",
      rewind: { anchorUserTurnId: "u1", disposition: "keep_user" },
    });

    const rewinds = (await store.read(editedSession.id)).entries
      .filter((entry) => entry.kind === "turn_rewind");
    expect(rewinds[0]).toMatchObject({
      revision: 2,
      turnId: "u1",
      payload: { disposition: "replace_user", reason: "edit", replacementUser: { text: "edited" } },
    });
    expect(rewinds[1]).toMatchObject({
      turnId: "u1",
      payload: { disposition: "keep_user", reason: "regenerate" },
    });
    // keep_user 不携带替换 user（JSON 往返后键不存在）
    expect(rewinds[1]?.payload).not.toHaveProperty("replacementUser");
    // replace_user / keep_user 都不追加独立 user 行
    const users = (await store.read(editedSession.id)).entries
      .filter((entry) => entry.kind === "user");
    expect(users.filter((entry) => entry.turnId === "u1")).toHaveLength(1);
  });

  it("re-dispatches the same user turn under a new runId without idempotency conflict", async () => {
    // 首次写入成功但模型启动失败：重试获得新 runId，同一 userTurnId 必须幂等吸收，
    // 不能因运行标识不同触发 TRANSCRIPT_IDEMPOTENCY_CONFLICT 而无法再次派发。
    const { store } = createStore();
    const session = makeSession();
    await prepareTranscriptDispatch({ store, session, userTurnId: "u-current", runId: "run-1" });
    await prepareTranscriptDispatch({ store, session, userTurnId: "u-current", runId: "run-2" });

    const users = (await store.read(session.id)).entries
      .filter((entry) => entry.kind === "user" && entry.turnId === "u-current");
    expect(users).toHaveLength(1);
    // 稳定 ID 显式包含 revision，不含运行标识
    expect(users[0]?.id).toBe("user:v1:u-current:r1");
    expect(users[0]).not.toHaveProperty("runId");
  });

  it("rejects a missing or non-user turn id", async () => {
    const { store } = createStore();
    const session = makeSession();
    await expect(prepareTranscriptDispatch({
      store, session, userTurnId: "missing", runId: "run-x",
    })).rejects.toThrow("TRANSCRIPT_USER_TURN_NOT_FOUND");
    await expect(prepareTranscriptDispatch({
      store, session, userTurnId: "m2", runId: "run-x",
    })).rejects.toThrow("TRANSCRIPT_USER_TURN_NOT_FOUND");
  });
});
