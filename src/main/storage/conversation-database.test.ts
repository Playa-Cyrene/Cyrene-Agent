import { withConversationDatabase } from "../../test-utils/conversation-storage";
import { ExecutionLedger } from "../orchestrator/execution-ledger";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationDatabaseClient } from "./conversation-database-client";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
describe("conversation SQLite transactions", () => {
  let root: string;
  let client: ConversationDatabaseClient;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrene-sqlite-')); client = new ConversationDatabaseClient(root); });
  afterEach(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const user = (text = 'hello') => ({ id: 'user:u1:r1', kind: 'user', turnId: 'u1', revision: 1, at: 1, payload: { text } });
  it.each(["keep_user", "replace_user"] as const)("rejects a stale %s without hiding a committed proactive message or reserving a run", async (disposition) => {
    const session = await client.call<{ id: string }>('chats.createSession', { mode: 'chat', purpose: 'proactive-chat' });
    const id = session.id;
    await client.call('transcript.append', id, user());
    await client.call('transcript.append', id, { id: 'answer-entry', kind: 'assistant', turnId: 'a1', at: 2, payload: { role: 'assistant', content: 'answer' } });
    await client.call('chats.getSession', id); // 窗口快照的最后一轮为 u1 → a1。
    await client.call('transcript.append', id, { id: 'proactive', kind: 'assistant', runId: 'proactive-intent-1', at: 3, payload: { role: 'assistant', content: 'keep proactive' } });
    const before = await client.call('transcript.audit', id);
    await expect(client.call('runs.admit', id, 'retry', {
      mode: 'chat',
      currentUser: { turnId: 'u1', text: disposition === 'replace_user' ? 'edited' : 'hello', visibleContent: 'fixture' },
      transcriptRewind: { anchorUserTurnId: 'u1', expectedAssistantMessageId: 'a1', disposition },
    }, 'retry-run')).rejects.toMatchObject({ code: 'TRANSCRIPT_REWIND_STALE' });
    expect(await client.call('transcript.audit', id)).toEqual(before);
    expect(withConversationDatabase(root, db => db.prepare('SELECT count(*) AS n FROM runs').get()?.n)).toBe(0);
    expect(withConversationDatabase(root, db => db.prepare('SELECT count(*) AS n FROM conversation_requests').get()?.n)).toBe(0);
    await client.close();
    expect(await client.call('chats.getSession', id)).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ content: 'keep proactive' })]) });
    expect(await client.call('transcript.audit', id)).toEqual(before);
  });

  it.each((["chat", "work"] as const).flatMap(mode =>
    (["keep_user", "replace_user"] as const).map(disposition => ({ mode, disposition })),
  ))("rejects $mode $disposition when compaction commits after the renderer snapshot", async ({ mode, disposition }) => {
    await client.call('transcript.append', 'c1', user());
    await client.call('transcript.append', 'c1', { id: 'answer-entry', kind: 'assistant', turnId: 'a1', at: 2, payload: { role: 'assistant', content: 'answer' } });
    const entries = await client.call<TranscriptEntry[]>('transcript.audit', 'c1');
    await client.call('transcript.compaction', 'c1', { id: 'compact', kind: 'compaction_checkpoint', at: 3, payload: {
      baseThroughSeq: 0, sourceThroughSeq: entries.at(-1)!.seq,
      sourceDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      replacement: { role: 'system', content: 'summary' }, trigger: 'manual',
    } });
    const before = await client.call('transcript.audit', 'c1');
    await expect(client.call('runs.admit', 'c1', 'retry', {
      mode, currentUser: { turnId: 'u1', text: 'hello', visibleContent: 'hello' },
      transcriptRewind: { anchorUserTurnId: 'u1', expectedAssistantMessageId: 'a1', disposition },
    }, 'retry-run')).rejects.toMatchObject({ code: mode === 'chat' ? 'TRANSCRIPT_REWIND_STALE' : 'TRANSCRIPT_REWIND_ACROSS_COMPACTION' });
    expect(await client.call('transcript.audit', 'c1')).toEqual(before);
    expect(withConversationDatabase(root, db => db.prepare('SELECT count(*) AS n FROM runs').get()?.n)).toBe(0);
    expect(withConversationDatabase(root, db => db.prepare('SELECT count(*) AS n FROM conversation_requests').get()?.n)).toBe(0);
  });

  it.each(["keep_user", "replace_user"] as const)("accepts an unchanged %s after a TTS patch and replays its receipt idempotently", async (disposition) => {
    await client.call('transcript.append', 'c1', user());
    await client.call('transcript.append', 'c1', { id: 'answer-entry', kind: 'assistant', turnId: 'a1', at: 2, payload: { role: 'assistant', content: 'answer' } });
    await client.call('transcript.presentation', 'c1', 'a1', 'tts:1', { ttsCacheKey: 'cache' }, 3);
    const facts = { mode: 'chat', currentUser: { turnId: 'u1', text: 'hello', visibleContent: 'hello' }, transcriptRewind: { anchorUserTurnId: 'u1', expectedAssistantMessageId: 'a1', disposition } };
    const receipt = await client.call('runs.admit', 'c1', 'retry', facts, 'retry-run');
    expect(receipt).toMatchObject({ status: 'prepared', duplicate: false });
    await client.call('runs.terminal', 'retry-run', 'completed');
    await client.call('transcript.append', 'c1', { id: 'later-proactive', kind: 'assistant', at: 4, payload: { role: 'assistant', content: 'later' } });
    expect(await client.call('runs.admit', 'c1', 'retry', facts, 'another-run')).toMatchObject({ runId: 'retry-run', duplicate: true });
    expect((await client.call<TranscriptEntry[]>('transcript.audit', 'c1')).filter(entry => entry.kind === 'turn_rewind')).toHaveLength(1);
  });

  it.each(['missing-identity', 'wrong-assistant', 'new-user', 'replaced-answer'])("rejects rewind with %s", async (change) => {
    await client.call('transcript.append', 'c1', user());
    await client.call('transcript.append', 'c1', { id: 'answer-entry', kind: 'assistant', turnId: 'a1', at: 2, payload: { role: 'assistant', content: 'answer' } });
    if (change === 'new-user') await client.call('transcript.append', 'c1', { ...user('next'), id: 'user:u2:r1', turnId: 'u2' });
    if (change === 'replaced-answer') await client.call('transcript.append', 'c1', { id: 'new-answer', kind: 'assistant', turnId: 'a2', at: 3, payload: { role: 'assistant', content: 'new answer' } });
    const before = await client.call('transcript.audit', 'c1');
    await expect(client.call('runs.admit', 'c1', 'retry', {
      mode: 'chat',
      currentUser: { turnId: 'u1', text: 'hello', visibleContent: 'hello' },
      transcriptRewind: { anchorUserTurnId: 'u1', disposition: 'keep_user', ...(change === 'missing-identity' ? {} : { expectedAssistantMessageId: change === 'wrong-assistant' ? 'wrong' : 'a1' }) },
    }, 'retry-run')).rejects.toMatchObject({ code: 'TRANSCRIPT_REWIND_STALE' });
    expect(await client.call('transcript.audit', 'c1')).toEqual(before);
  });
  it("returns the original user after retry and restart", async () => {
    const first = await client.call('transcript.append', 'c1', user());
    expect(await client.call('transcript.append', 'c1', { ...user(), at: 10 })).toEqual(first);
    await client.close();
    expect(await client.call('transcript.append', 'c1', user())).toEqual(first);
  });
  it("isolates conflicting entries from the next write", async () => {
    await client.call('transcript.append', 'c1', user());
    await expect(client.call('transcript.append', 'c1', user('different'))).rejects.toMatchObject({ code: 'TRANSCRIPT_ENTRY_CONFLICT' });
    const next = await client.call<TranscriptEntry>('transcript.append', 'c1', { ...user(), id: 'user:u2:r1', turnId: 'u2' });
    expect(next.seq).toBe(2);
  });
  it("scopes mutations to a message and keeps terminal retries stable", async () => {
    const patch = { content: 'done' };
    const first = await client.call('transcript.presentation', 'c1', 'm1', 'terminal', patch, 1);
    expect(await client.call('transcript.presentation', 'c1', 'm1', 'terminal', patch, 2)).toEqual(first);
    await expect(client.call('transcript.presentation', 'c1', 'm1', 'terminal', { content: 'changed' }, 3)).rejects.toMatchObject({ code: 'PRESENTATION_MUTATION_CONFLICT' });
    expect((await client.call<TranscriptEntry>('transcript.presentation', 'c1', 'm2', 'terminal', patch, 4)).seq).toBe(2);
  });
  it("imports original files without rewriting the backup", async () => {
    const dir = path.join(root, 'transcripts', 'c1');
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify({ ...user(), seq: 1 }) + '\n' + '{"broken":';
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), text);
    expect((await client.call<TranscriptEntry[]>('transcript.audit', 'c1')).length).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8')).toBe(text);
  });
  it("admits queued input and its canonical row atomically", async () => {
    const session = await client.call<{
      id: string;
    }>('chats.createSession', { mode: 'chat' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: 'hello', visibleContent: 'hello' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: true, claimed: true });
    expect(await client.call('transcript.audit', session.id)).toEqual([expect.objectContaining({ kind: 'user', turnId: 'q1' })]);
  });
  it("cancels only the claimed request and rejects a late dispatch without consuming its successor", async () => {
    const { id } = await client.call<{ id: string }>("chats.createSession", { mode: "chat" });
    for (const key of ["u1", "u2"]) {
      await client.call("chats.enqueuePendingMessage", id, { id: key, rawContent: "hello", visibleContent: "hello" });
    }
    await client.call("chats.claimPendingMessage", id, "u1");
    expect(await client.call("runs.cancelUnstartedRequest", id, "u1")).toBe(true);
    expect(await client.call("runs.admit", id, "u1", facts(), "late")).toMatchObject({ status: "cancelled", duplicate: true });
    expect(await client.call("chats.claimPendingMessage", id, "u1")).toMatchObject({ claimed: false });
    expect(await client.call("chats.claimPendingMessage", id, "u2")).toMatchObject({ claimed: true, userMessage: { id: "u2" } });
  });
  it("keeps successful tool receipts after restart", async () => {
    await client.call('tools.begin', 'c1', 'operation1', 'fingerprint');
    await client.call('tools.finish', 'c1', 'operation1', 'fingerprint', { status: 'succeeded', output: 'done' });
    await client.close();
    expect(await client.call('tools.begin', 'c1', 'operation1', 'fingerprint')).toMatchObject({ outcome: { status: 'succeeded', output: 'done' } });
  });
  const facts = (text = 'hello') => ({ mode: 'chat', assistantTurnId: 'assistant1', currentUser: { turnId: 'u1', text, visibleContent: text } });
  it.each(['send', 'pending', 'keep_user', 'replace_user'])("Learn 忙碌拒绝在 %s 后重启仍恢复关联用户和终态提示", async (source) => {
    const session = await client.call<any>('chats.createSession', { mode: 'learn' });
    const id = session.id;
    const notice = '另一个学习会话正在运行，本轮尚未执行。请等待该任务结束后重试。';
    const busy = { error: 'LEARN_RUN_ACTIVE:other-run', notice };
    const rewind = source === 'keep_user' || source === 'replace_user';
    if (rewind) {
      await client.call('transcript.append', id, user());
      await client.call('transcript.append', id, { id: 'old-answer', kind: 'assistant', turnId: 'old-assistant', at: 2, payload: { role: 'assistant', content: 'old answer' } });
    }
    if (source === 'pending') {
      await client.call('chats.enqueuePendingMessage', id, { id: 'u1', rawContent: 'hello', visibleContent: 'hello' });
      expect(await client.call('chats.claimPendingMessage', id)).toMatchObject({ ok: true, claimed: true });
    }
    const input = { ...facts(source === 'replace_user' ? 'edited' : 'hello'), mode: 'learn',
      ...(rewind ? { transcriptRewind: { anchorUserTurnId: 'u1', disposition: source, expectedAssistantMessageId: 'old-assistant' } } : {}) };
    if (source === 'send') input.currentUser.visibleContent = '展示文本';
    const requestId = rewind ? 'assistant1' : 'u1';
    // 固定旧时间，确保拒绝终态同时推进侧栏时间，而非碰巧与 claim 同毫秒。
    withConversationDatabase(root, db => db.prepare("UPDATE conversations SET record_json=json_set(record_json,'$.updatedAt',1) WHERE id=?").run(id));
    const recordBefore = await client.call<any>('chats.getSessionRecord', id);
    await client.call('runs.rejectLearnBusy', id, requestId, input, 'busy-run', busy);
    const terminalAt = (await client.call<any>('chats.getSession', id)).messages[1].at;
    const expectedRecord = { ...recordBefore, messageCount: 2, updatedAt: terminalAt };
    expect(await client.call('chats.getSessionRecord', id)).toEqual(expectedRecord);
    expect((await client.call<any[]>('chats.listSessions')).find(item => item.id === id)).toMatchObject({ messageCount: 2, updatedAt: terminalAt });
    // 不写 renderer 检查点：模拟 invoke 返回前窗口已关闭。
    await client.close();
    const restored = await client.call<any>('chats.getSession', id);
    expect(await client.call('chats.getSessionRecord', id)).toEqual(expectedRecord);
    expect((await client.call<any[]>('chats.listSessions')).find(item => item.id === id)).toMatchObject({ messageCount: restored.messages.length, updatedAt: terminalAt });
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]).toMatchObject({ role: 'user', content: source === 'send' ? '展示文本' : source === 'replace_user' ? 'edited' : 'hello' });
    expect(restored.messages[1]).toMatchObject({ id: 'assistant1', role: 'model', content: '',
      processMessages: [{ id: 'process-0', content: notice }],
      runSnapshot: { status: 'terminal', terminalStatus: 'runtime_error' } });
    const entries = await client.call<TranscriptEntry[]>('transcript.audit', id);
    const assistant = entries.find(entry => entry.kind === 'assistant' && entry.turnId === 'assistant1');
    expect(assistant).toMatchObject({ runId: expect.any(String) });
    expect(await client.call('runs.lookup', id, requestId, input)).toMatchObject({ runId: assistant!.runId, status: 'failed', error: busy.error });
    await client.call('runs.rejectLearnBusy', id, requestId, input, 'retry-run', busy);
    expect(await client.call('transcript.audit', id)).toEqual(entries);
    expect(await client.call('chats.getSessionRecord', id)).toEqual(expectedRecord);
    // 原有 renderer 终态检查点仍可更新该 canonical target。
    await client.call('transcript.presentation', id, 'assistant1', 'renderer-terminal', {
      processMessages: [{ id: 'process-0', content: notice, seq: 2 }],
      runSnapshot: { status: 'terminal', terminalStatus: 'runtime_error', updatedAt: 5 },
    }, 5);
    await client.close();
    expect((await client.call<any>('chats.getSession', id)).messages[1].processMessages).toEqual([{ id: 'process-0', content: notice, seq: 2 }]);
    // 失败终态不占运行槽，用户随后可以重新发送。
    expect(await client.call('runs.admit', id, 'u2', { ...input, transcriptRewind: undefined,
      assistantTurnId: 'assistant2', currentUser: { turnId: 'u2', text: 'retry', visibleContent: 'retry' } }, 'next-run')).toMatchObject({ duplicate: false });
  });
  it("Learn 忙碌终态写入失败时回滚用户、assistant 和运行回执", async () => {
    const session = await client.call<any>('chats.createSession', { mode: 'learn' });
    await client.call('transcript.audit', session.id);
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_busy BEFORE INSERT ON transcript_entries WHEN NEW.kind='presentation_patch' BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    const input = { ...facts(), mode: 'learn' };
    await expect(client.call('runs.rejectLearnBusy', session.id, 'u1', input, 'busy-run', { error: 'LEARN_RUN_ACTIVE:other', notice: '稍后重试' })).rejects.toThrow();
    expect(await client.call('transcript.audit', session.id)).toEqual([]);
    expect(await client.call('runs.lookup', session.id, 'u1', input)).toBeNull();
    expect(await client.call('runs.all')).toEqual([]);
  });
  it("Learn 忙碌统计写入失败时与终态轨迹和回执一起回滚", async () => {
    const session = await client.call<any>('chats.createSession', { mode: 'learn' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'u1', rawContent: 'hello', visibleContent: 'hello' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: true, claimed: true });
    const record = await client.call('chats.getSessionRecord', session.id);
    const entries = await client.call('transcript.audit', session.id);
    const runs = await client.call('runs.all');
    const input = { ...facts(), mode: 'learn' };
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_busy_stats BEFORE UPDATE OF record_json ON conversations BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    await expect(client.call('runs.rejectLearnBusy', session.id, 'u1', input, 'busy-run', { error: 'LEARN_RUN_ACTIVE:other', notice: '稍后重试' })).rejects.toThrow();
    await client.close();
    expect(await client.call('chats.getSessionRecord', session.id)).toEqual(record);
    expect(await client.call('transcript.audit', session.id)).toEqual(entries);
    // 重开数据库会将此前 claim 预留的 prepared run 标为 interrupted。
    expect((await client.call<any[]>('runs.all')).map(item => item.runId)).toEqual((runs as any[]).map(item => item.runId));
    expect(await client.call('runs.lookup', session.id, 'u1', input)).not.toMatchObject({ status: 'failed' });
  });
  it("returns one run for concurrent identical admissions and the completed receipt after restart", async () => {
    const [one, two] = await Promise.all([client.call<any>('runs.admit', 'c1', 'u1', facts(), 'r1'), client.call<any>('runs.admit', 'c1', 'u1', facts(), 'r2')]);
    expect(one.runId).toBe(two.runId);
    expect(two.duplicate).toBe(true);
    await client.call('runs.terminal', one.runId, 'completed');
    await client.close();
    expect(await client.call('runs.admit', 'c1', 'u1', facts(), 'r3')).toMatchObject({ runId: one.runId, status: 'completed', duplicate: true });
    await expect(client.call('runs.admit', 'c1', 'u1', facts('changed'), 'r4')).rejects.toMatchObject({ code: 'REQUEST_IDEMPOTENCY_CONFLICT' });
    expect(await client.call('runs.admit', 'c1', 'u2', { ...facts('next'), currentUser: { turnId: 'u2', text: 'next', visibleContent: 'next' } }, 'r5')).toMatchObject({ duplicate: false });
  });
  it("贴纸消息：canonical 存自然语言文本，模型文本差异绝不阻塞 run", async () => {
    const session = await client.call<{ id: string }>('chats.createSession', { mode: 'chat' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: '抱抱 [sticker:playful]', visibleContent: '抱抱', userSticker: 'playful' });
    const modelText = '抱抱\n\n<internal_context>用户发送表情包：你看人家嘛</internal_context>';
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: true, claimed: true, modelText });
    // canonical user 条目存模型文本（自然语言，不含 [sticker:] 标记）；UI 侧由展示补丁承担
    const entries = await client.call<TranscriptEntry[]>('transcript.audit', session.id);
    expect(entries.find((entry) => entry.kind === 'user')).toMatchObject({ turnId: 'q1', payload: { text: modelText } });
    expect(entries.find((entry) => entry.kind === 'presentation_patch')?.payload).toMatchObject({
      patch: { content: '抱抱', sticker: 'playful' },
    });
    const stickerFacts = (text: string, sticker = 'playful') => ({ mode: 'chat', assistantTurnId: 'assistant1', currentUser: { turnId: 'q1', text, visibleContent: '抱抱', sticker } });
    // 旧口径（含标记的原文 / 剥离标记的投影文本）lookup 均不抛幂等冲突：贴纸模型文本不参与判等
    expect(await client.call('runs.lookup', session.id, 'q1', stickerFacts('抱抱 [sticker:playful]'))).toBeNull();
    expect(await client.call('runs.lookup', session.id, 'q1', stickerFacts('抱抱'))).toBeNull();
    // 渲染端用同源模型文本 admit 成功
    const admit = await client.call<any>('runs.admit', session.id, 'q1', stickerFacts('抱抱'));
    expect(admit).toMatchObject({ duplicate: false });
    // admit 后（已有 dispatch_json）模型文本漂移也不阻塞：返回既有 run
    expect(await client.call('runs.admit', session.id, 'q1', stickerFacts('任意改动的模型文本'))).toMatchObject({ runId: admit.runId, duplicate: true });
    // 贴纸 id 仍参与判等：换表情包必须冲突（编辑/重放依旧可识别）
    await expect(client.call('runs.lookup', session.id, 'q1', stickerFacts('抱抱', 'hmph'))).rejects.toMatchObject({ code: 'REQUEST_IDEMPOTENCY_CONFLICT' });
  });
  it("非贴纸消息的模型文本差异仍然阻塞（兜底只豁免贴纸）", async () => {
    const session = await client.call<{ id: string }>('chats.createSession', { mode: 'chat' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: '普通消息', visibleContent: '普通消息' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: true, claimed: true });
    const plainFacts = (text: string) => ({ mode: 'chat', currentUser: { turnId: 'q1', text, visibleContent: '普通消息' } });
    expect(await client.call('runs.lookup', session.id, 'q1', plainFacts('普通消息'))).toBeNull();
    await expect(client.call('runs.lookup', session.id, 'q1', plainFacts('改内容'))).rejects.toMatchObject({ code: 'REQUEST_IDEMPOTENCY_CONFLICT' });
  });
  it("rolls back user and request admission when run insertion fails", async () => {
    await client.call('transcript.read', 'c1');
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    await expect(client.call('runs.admit', 'c1', 'u1', facts(), 'r1')).rejects.toThrow();
    expect(await client.call('transcript.audit', 'c1')).toEqual([]);
    expect(withConversationDatabase(root, db => db.prepare('SELECT count(*) AS n FROM conversation_requests').get()?.n)).toBe(0);
    withConversationDatabase(root, db => db.exec('DROP TRIGGER fail_run'));
    expect(await client.call('runs.admit', 'c1', 'u1', facts(), 'r2')).toMatchObject({ duplicate: false });
  });
  it("keeps queued intent when canonical insertion fails and reserves a run on successful claim", async () => {
    const session = await client.call<{
      id: string;
    }>('chats.createSession', { mode: 'chat' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: 'hello', visibleContent: 'hello' });
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON transcript_entries WHEN NEW.kind='user' BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: false, error: 'write-failed' });
    expect(await client.call('chats.getPendingMessages', session.id)).toHaveLength(1);
    expect(await client.call('chats.getPendingDispatch', session.id)).toBeNull();
    withConversationDatabase(root, db => db.exec('DROP TRIGGER fail_user'));
    await client.call('chats.claimPendingMessage', session.id);
    const reserved = withConversationDatabase(root, db => db.prepare('SELECT run_id FROM conversation_requests WHERE conversation_id=?').get(session.id)?.run_id);
    expect(typeof reserved).toBe('string');
    expect(await client.call('runs.admit', session.id, 'q1', { mode: 'chat', currentUser: { turnId: 'q1', text: 'hello', visibleContent: 'hello' } }, 'other')).toMatchObject({ runId: reserved });
  });
  it("rejects a poisoned queue head and admits the following input", async () => {
    const session = await client.call<{
      id: string;
    }>('chats.createSession', { mode: 'chat' });
    await client.call('transcript.append', session.id, { ...user('original'), turnId: 'q1', id: 'original' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: 'different', visibleContent: 'different' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q2', rawContent: 'next', visibleContent: 'next' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: false, error: 'request-conflict' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: true, claimed: true, userMessage: { id: 'q2' } });
  });
  it("does not repair pending state when reading an imported conversation", async () => {
    const session = await client.call<{
      id: string;
    }>('chats.createSession', { mode: 'chat' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'q1', rawContent: 'hello', visibleContent: 'hello' });
    await client.call('chats.claimPendingMessage', session.id);
    const before = withConversationDatabase(root, db => db.prepare('SELECT record_json FROM conversations WHERE id=?').get(session.id)?.record_json);
    await client.call('chats.getSession', session.id);
    await client.call('transcript.read', session.id);
    await client.call('transcript.audit', session.id);
    expect(withConversationDatabase(root, db => db.prepare('SELECT record_json FROM conversations WHERE id=?').get(session.id)?.record_json)).toBe(before);
  });
  it("interrupts prepared requests on restart and releases the conversation", async () => {
    await client.call('runs.admit', 'c1', 'u1', facts(), 'r1');
    await client.close();
    expect(await client.call('runs.lookup', 'c1', 'u1', facts())).toMatchObject({ runId: 'r1', status: 'interrupted' });
    expect(await client.call('runs.admit', 'c1', 'u2', { currentUser: { turnId: 'u2', text: 'new', visibleContent: 'new' } }, 'r2')).toMatchObject({ duplicate: false });
  });
  it("keeps archived identities comparable after restart", async () => {
    const entry = await client.call<any>('transcript.append', 'c1', user());
    const entries = await client.call<any[]>('transcript.audit', 'c1');
    await client.call('transcript.compaction', 'c1', { id: 'compact', kind: 'compaction_checkpoint', at: 2, payload: { baseThroughSeq: 1, sourceThroughSeq: 1, sourceDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), replacement: { role: 'system', content: 'summary' }, trigger: 'manual' } });
    await client.call('transcript.archive', 'c1', 1);
    await client.close();
    expect(await client.call('transcript.append', 'c1', { ...user(), at: 10 })).toEqual(entry);
    expect((await client.call<any>('transcript.read', 'c1')).entries.map((e: any) => e.id)).toEqual(['compact']);
  });
  it("commits the successful tool receipt with the canonical tool result", async () => {
    await client.call('tools.begin', 'c1', 'r1:t1', 'fingerprint');
    await client.call('tools.finish', 'c1', 'r1:t1', 'fingerprint', { status: 'succeeded', output: 'done' }, true);
    await client.call('transcript.read', 'c1');
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON transcript_entries WHEN NEW.kind='tool_result' BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    const result = { id: 'result', kind: 'tool_result', at: 1, runId: 'r1', payload: { assistantEntryId: 'a1', toolCallId: 't1', outcome: 'success', message: { role: 'tool', toolCallId: 't1', name: 'tool', content: 'done' } } };
    await expect(client.call('transcript.append', 'c1', result)).rejects.toThrow();
    expect(withConversationDatabase(root, db => db.prepare('SELECT status FROM tool_operations').get()?.status)).toBe('ready');
    withConversationDatabase(root, db => db.exec('DROP TRIGGER fail_result'));
    await client.call('transcript.append', 'c1', result);
    await client.close();
    expect(await client.call('tools.begin', 'c1', 'r1:t1', 'fingerprint')).toMatchObject({ outcome: { output: 'done' } });
  });
  it("marks started operations unknown on restart", async () => {
    await client.call('tools.begin', 'c1', 'operation1', 'fingerprint');
    await client.close();
    await expect(client.call('tools.begin', 'c1', 'operation1', 'fingerprint')).rejects.toMatchObject({ code: 'EXECUTION_OUTCOME_UNKNOWN' });
  });
  it("executes concurrent duplicate tool submissions once", async () => {
    const ledger = new ExecutionLedger();
    let executed = 0;
    const invoke = () => ledger.execute({ logicalInvocationId: 't1', capability: 'write', targetRefs: [], args: {} }, async () => { executed++; return { status: 'succeeded', output: 'done' }; });
    const results = await Promise.all([invoke(), invoke()]);
    expect(executed).toBe(1);
    expect(results[1].cached).toBe(true);
  });
  it("exports a consistent SQLite backup", async () => {
    await client.call('transcript.append', 'c1', user());
    const destination = path.join(root, 'backup.sqlite');
    await client.call('backup', destination);
    expect(fs.existsSync(destination)).toBe(true);
  });
  it("preserves a valid request receipt when rejecting a conflicting queue head", async () => {
    const session = await client.call<any>('chats.createSession', { mode: 'chat' });
    await client.call('runs.admit', session.id, 'u1', facts(), 'r1');
    await client.call('runs.terminal', 'r1', 'completed');
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'u1', rawContent: 'changed', visibleContent: 'changed' });
    expect(await client.call('chats.claimPendingMessage', session.id)).toMatchObject({ ok: false, error: 'request-conflict' });
    expect(await client.call('runs.lookup', session.id, 'u1', facts())).toMatchObject({ runId: 'r1', status: 'completed', duplicate: true });
  });
  it("rolls back adjustment consumption and its canonical user together", async () => {
    const session = await client.call<any>('chats.createSession', { mode: 'work' });
    await client.call('chats.enqueuePendingMessage', session.id, { id: 'adjust1', rawContent: 'insert', visibleContent: 'insert' });
    await client.call('chats.markPendingAdjust', session.id, 'adjust1', 'r1');
    withConversationDatabase(root, db => db.exec("CREATE TRIGGER fail_adjust BEFORE INSERT ON transcript_entries BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    expect(await client.call('chats.commitPendingAdjust', session.id, 'adjust1', 'r1')).toEqual({ ok: false, error: 'write-failed' });
    expect(await client.call('chats.getPendingMessages', session.id)).toMatchObject([{ id: 'adjust1', adjustRunId: 'r1' }]);
    expect(await client.call('transcript.audit', session.id)).toEqual([]);
    withConversationDatabase(root, db => db.exec('DROP TRIGGER fail_adjust'));
    expect(await client.call('chats.commitPendingAdjust', session.id, 'adjust1', 'r1')).toMatchObject({ ok: true });
    expect(await client.call('chats.getPendingMessages', session.id)).toEqual([]);
  });
  it("returns the existing tool completion and rejects a different fingerprint", async () => {
    const outcome = { status: 'succeeded', output: 'done' };
    await client.call('tools.begin', 'c1', 'op1', 'same');
    await client.call('tools.finish', 'c1', 'op1', 'same', outcome, true);
    await expect(client.call('tools.finish', 'c1', 'op1', 'same', outcome, true)).resolves.toBeUndefined();
    await expect(client.call('tools.finish', 'c1', 'op1', 'changed', outcome, true)).rejects.toMatchObject({ code: 'E_LOGICAL_INVOCATION_CONFLICT' });
  });
  it("does not resurrect deleted conversations from retained legacy files", async () => {
    const dir = path.join(root, 'cyrene-chats', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, 'c1.json'), JSON.stringify({ id: 'c1', schemaVersion: 1, title: 'old', mode: 'chat', createdAt: 1, updatedAt: 1, messages: [] }));
    await client.call('chats.getSessionRecord', 'c1');
    await client.call('chats.deleteSession', 'c1');
    await client.close();
    expect(await client.call('chats.getSessionRecord', 'c1')).toBeNull();
    await expect(client.call('transcript.append', 'c1', user())).rejects.toMatchObject({ code: 'CONVERSATION_DELETED' });
    expect(fs.existsSync(path.join(dir, 'c1.json'))).toBe(true);
  });
  it("admits canonical input even when its derived sticker write fails", async () => {
    const session=await client.call<any>('chats.createSession',{mode:'chat'});
    await client.call('chats.enqueuePendingMessage',session.id,{id:'q1',rawContent:'hello',visibleContent:'hello',userSticker:'calm'});
    withConversationDatabase(root,db=>db.exec("CREATE TRIGGER fail_presentation BEFORE INSERT ON transcript_entries WHEN NEW.kind='presentation_patch' BEGIN SELECT RAISE(ABORT,'INJECTED'); END"));
    expect(await client.call('chats.claimPendingMessage',session.id)).toMatchObject({ok:true,claimed:true});
    expect(await client.call('transcript.audit',session.id)).toEqual([expect.objectContaining({kind:'user',turnId:'q1'})]);
    const receipt=withConversationDatabase(root,db=>db.prepare('SELECT run_id FROM conversation_requests WHERE conversation_id=?').get(session.id));
    expect(typeof receipt?.run_id).toBe('string');
  });

});
