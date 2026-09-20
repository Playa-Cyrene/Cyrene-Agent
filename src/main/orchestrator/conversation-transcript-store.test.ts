import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptAppendInput } from "./conversation-transcript-types";

// 测试根目录回收列表
const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-"));
  roots.push(root);
  return {
    root,
    store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
    jsonlPath: (conversationId: string) =>
      path.join(root, "transcripts", conversationId, "transcript.jsonl"),
  };
}

// 构造一条 user 轨迹追加草稿（信封字段 + 文本载荷）
function userDraft(id: string, turnId: string, revision: number, text: string): TranscriptAppendInput {
  return { id, at: 1_000, kind: "user", turnId, revision, payload: { text } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ConversationTranscriptStore", () => {
  it("assigns monotonic seq and deduplicates entryId plus user turn revision", async () => {
    const { store } = createStore();
    const first = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    const retried = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    expect(first.seq).toBe(1);
    expect(retried.id).toBe("e1");
    expect((await store.read("c1")).entries).toHaveLength(1);
    await expect(store.append("c1", userDraft("e2", "u1", 1, "changed")))
      .rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
  });

  it("repairs only a truncated final JSONL line", async () => {
    const { store, jsonlPath } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    // 模拟进程死亡留下的半行：无换行结尾且 JSON 不完整
    await fs.promises.appendFile(jsonlPath("c1"), '{"seq":2,"id":"broken"', "utf8");
    await store.append("c1", userDraft("e2", "u2", 1, "two"));
    expect((await store.read("c1")).entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("serializes concurrent appends for one conversation", async () => {
    const { store } = createStore();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.append("c1", userDraft(`e${index}`, `u${index}`, 1, String(index))),
    ));
    expect((await store.read("c1")).entries.map((entry) => entry.seq))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("replays only rows after snapshot throughSeq and remembers old idempotency keys", async () => {
    const { store } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await store.checkpoint("c1");
    await store.append("c1", userDraft("e2", "u2", 1, "two"));
    const replayed = await store.read("c1");
    expect(replayed.throughSeq).toBe(2);
    expect(replayed.entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    // 快照恢复后重试旧 entryId：仍被幂等识别吸收，不重复写入
    expect((await store.append("c1", userDraft("e1", "u1", 1, "retry"))).id).toBe("e1");
  });

  it("rejects conversation ids that escape the transcripts root", async () => {
    const { store } = createStore();
    await expect(store.append("../escape", userDraft("e1", "u1", 1, "x"))).rejects.toThrow();
    await expect(store.append("a/b", userDraft("e1", "u1", 1, "x"))).rejects.toThrow();
  });

  it("deletes only the targeted conversation directory", async () => {
    const { store, root } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await store.append("c2", userDraft("e2", "u2", 1, "two"));
    await store.deleteConversation("c1");
    expect(fs.existsSync(path.join(root, "transcripts", "c1"))).toBe(false);
    expect((await store.read("c2")).entries).toHaveLength(1);
  });
});
