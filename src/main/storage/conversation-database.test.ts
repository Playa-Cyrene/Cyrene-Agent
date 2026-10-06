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
  it("keeps successful tool receipts after restart", async () => {
    await client.call('tools.begin', 'c1', 'operation1', 'fingerprint');
    await client.call('tools.finish', 'c1', 'operation1', 'fingerprint', { status: 'succeeded', output: 'done' });
    await client.close();
    expect(await client.call('tools.begin', 'c1', 'operation1', 'fingerprint')).toMatchObject({ outcome: { status: 'succeeded', output: 'done' } });
  });
  const facts = (text = 'hello') => ({ mode: 'chat', assistantTurnId: 'assistant1', currentUser: { turnId: 'u1', text, visibleContent: text } });
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
