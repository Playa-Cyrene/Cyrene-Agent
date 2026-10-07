import { parentPort, workerData } from "node:worker_threads";
import { importRuns, runCommand } from "./conversation-run-repository";
import { importTaskSessions, runTaskCommand } from "./conversation-task-repository";
import { importTokenUsage, runUsageCommand } from "./conversation-usage-repository";
import { createHash, randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { initializeConversationDatabase, ConversationStoreError, persisted } from "./conversation-database";
import * as chats from "../chats/chats-store-core";
import { LegacyConversationTranscriptReader } from "../orchestrator/legacy-conversation-transcript-reader";
import { assertValidPresentationPatch, type TranscriptAppendInput, type TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { reduceTranscriptProjection, isUserTurnRewindableInModelView } from "../orchestrator/conversation-transcript-projection";
import { buildLegacyBackfillDrafts } from "../orchestrator/conversation-transcript-coordinator";
import { diagnosticHash } from "./conversation-store-error";
const database = initializeConversationDatabase(workerData.root);
chats.initialize();
importRuns(database);
importTaskSessions(database);
importTokenUsage(database);
const legacy = new LegacyConversationTranscriptReader(workerData.root);
async function importTranscript(id: string): Promise<void> {
  if (database.db.prepare('SELECT transcript_imported FROM conversations WHERE id=?').get(id)?.transcript_imported)
    return;
  const snapshot = await legacy.read(id);
  const entries = snapshot.archives.length ? await legacy.readAuditEntries(id) : snapshot.entries;
  if (entries.some((entry, index) => entry.seq !== index + 1))
    throw new ConversationStoreError('CONVERSATION_STORE_INTEGRITY_ERROR');
  const ids = new Set(entries.map(e => e.id));
  if (snapshot.seenEntryIds.some(id => !ids.has(id)))
    throw new ConversationStoreError('CONVERSATION_STORE_INTEGRITY_ERROR');
  database.transaction(() => {
    database.ensure(id);
    for (const entry of entries)
      database.insert(id, entry);
    const record = database.record(id);
    if (record?.schemaVersion === 1) {
      const turns = new Set(entries.filter(entry => entry.kind === 'user' || entry.kind === 'assistant').map(entry => entry.turnId));
      for (const draft of buildLegacyBackfillDrafts(record.messages)) {
        const message = draft.message;
        if (turns.has(message.id))
          continue;
        database.append(id, message.role === 'user'
          ? { id: `migration:v2:${message.id}:canonical`, kind: 'user', turnId: message.id, revision: 1, at: message.at, payload: { text: draft.text, attachments: draft.attachments } }
          : { id: `migration:v2:${message.id}:canonical`, kind: 'assistant', turnId: message.id, at: message.at, payload: { role: 'assistant', content: draft.text } });
        database.append(id, { id: `migration:v2:${message.id}:presentation:r1`, kind: 'presentation_patch', at: message.at, payload: { messageId: message.id, patchRevision: 1, patch: draft.presentationPatch } });
      }
      const { messages: _messages, schemaVersion: _version, ...metadata } = record;
      database.saveRecord({ ...metadata, schemaVersion: 2, messageCount: reduceTranscriptProjection(database.entries(id, true)).messages.length });
    }
    try {
      reconcilePending(id);
    }
    catch (error) {
      if (!(error instanceof ConversationStoreError) || !['TRANSCRIPT_ENTRY_CONFLICT', 'REQUEST_IDEMPOTENCY_CONFLICT'].includes(error.code))
        throw error;
      const metadata = database.record(id)!;
      const pending = metadata.pendingDispatch!;
      database.db.prepare("INSERT INTO conversation_requests(conversation_id,request_id,payload_json,status,error_code) VALUES(?,?,?,'rejected',?) ON CONFLICT(conversation_id,request_id) DO NOTHING").run(id, pending.messageId, JSON.stringify(pending.userMessage), error.code);
      delete metadata.pendingDispatch;
      database.saveRecord(metadata);
    }
    database.db.prepare('UPDATE conversations SET transcript_imported=1,archived_through=?,projection_json=? WHERE id=?')
      .run(Math.max(0, ...snapshot.archives.map(a => a.throughSeq)), JSON.stringify(snapshot.projection), id);
  });
}
function presentation(id: string, messageId: string, mutationKey: string, patch: any, at: number): TranscriptEntry {
  assertValidPresentationPatch(patch);
  return database.transaction(() => {
    const row = database.db.prepare("SELECT entry_json FROM transcript_entries WHERE conversation_id=? AND message_id=? AND mutation_key=? AND kind='presentation_patch'").get(id, messageId, mutationKey);
    if (row) {
      const existing = JSON.parse(row.entry_json as string);
      if (!isDeepStrictEqual(existing.payload.patch, persisted(patch)))
        throw new ConversationStoreError('PRESENTATION_MUTATION_CONFLICT', { messageIdHash: diagnosticHash(messageId), mutationKeyHash: diagnosticHash(mutationKey), inputHash: diagnosticHash(patch), existingHash: diagnosticHash(existing.payload.patch), existingSeq: existing.seq, existingPatchRevision: existing.payload.patchRevision });
      return existing;
    }
    const max = database.db.prepare("SELECT MAX(patch_revision) AS revision FROM transcript_entries WHERE conversation_id=? AND message_id=?").get(id, messageId);
    return database.append(id, { id: `presentation:${messageId}:m${createHash('sha256').update(mutationKey).digest('hex')}`, kind: 'presentation_patch', at,
      payload: { messageId, mutationKey, patchRevision: Number(max?.revision ?? 0) + 1, patch } });
  });
}
function reconcilePending(id: string): void {
  const pending = chats.getPendingDispatch(id);
  if (!pending?.userMessage)
    return;
  const user = pending.userMessage;
  const intent = { turnId: user.id, text: user.text, visibleContent: user.visibleContent,
    ...(user.attachments?.length ? { attachments: user.attachments } : {}), ...(user.sticker ? { sticker: user.sticker } : {}) };
  const previous = database.db.prepare('SELECT payload_json,status FROM conversation_requests WHERE conversation_id=? AND request_id=?').get(id, user.id);
  if (previous) {
    const facts = JSON.parse(previous.payload_json as string);
    if (previous.status === 'rejected' || !isDeepStrictEqual(facts.currentUser ?? facts, persisted(intent)))
      throw new ConversationStoreError('REQUEST_IDEMPOTENCY_CONFLICT');
  }
  const canonical = database.append(id, { id: `user:v1:${user.id}:r1`, kind: 'user', turnId: user.id, revision: 1, at: user.at,
    payload: { text: user.text, ...(user.attachments?.length ? { attachments: user.attachments } : {}) } });
  if (!previous) database.db.prepare("INSERT INTO conversation_requests(conversation_id,request_id,payload_json,status) VALUES(?,?,?,'admitted')").run(id, user.id, JSON.stringify(intent));
  const patch = { ...(user.sticker ? { sticker: user.sticker } : {}), ...(user.visibleContent !== user.text ? { content: user.visibleContent } : {}) };
  if (Object.keys(patch).length) {
    try {
      presentation(id, canonical.id, `pending:${user.id}`, patch, user.at);
    }
    catch (error) {
      console.warn('[conversation-store] 待发消息展示更新失败:', error);
    }
  }
  const record = database.record(id);
  if (record?.schemaVersion === 2) {
    record.messageCount = reduceTranscriptProjection(database.entries(id, true)).messages.length;
    database.saveRecord(record);
  }
}
async function execute(method: string, args: any[]): Promise<unknown> {
  if (method === 'close') {
    database.close();
    return null;
  }
  if (method === 'backup') {
    await backup(database.db, args[0]);
    return;
  }
  if (method === 'barrier')
    return;
  if (method.startsWith('runs.')) {
    if (method === 'runs.admit') {
      await importTranscript(args[0]);
      return database.transaction(() => {
        const existing = runCommand(database, 'runs.lookup', args);
        if (existing) return existing;
        const [id, , facts, runId] = args;
        const user = facts.currentUser;
        const drafts: TranscriptAppendInput[] = [];
        if (user && facts.transcriptRewind) {
          const rewind = facts.transcriptRewind;
          const entries = database.entries(id);
          const projection = reduceTranscriptProjection(database.entries(id, true));
          if (!projection.state?.nodes.some(node => node.kind === 'user' && node.turnId === rewind.anchorUserTurnId))
            throw new ConversationStoreError('TRANSCRIPT_REWIND_ANCHOR_NOT_FOUND');
          if (!isUserTurnRewindableInModelView(entries, rewind.anchorUserTurnId))
            throw new ConversationStoreError('TRANSCRIPT_REWIND_ACROSS_COMPACTION');
          drafts.push({ id: `${runId}:rewind:${rewind.anchorUserTurnId}`, at: Date.now(), kind: 'turn_rewind', runId, turnId: rewind.anchorUserTurnId,
            ...(rewind.disposition === 'replace_user' ? { revision: Math.max(0, ...entries.filter(entry => entry.turnId === rewind.anchorUserTurnId).map(entry => entry.revision ?? 0)) + 1 } : {}),
            payload: { anchorUserTurnId: rewind.anchorUserTurnId, disposition: rewind.disposition, reason: rewind.disposition === 'replace_user' ? 'edit' : 'regenerate',
              ...(rewind.disposition === 'replace_user' ? { replacementUser: { text: user.text, ...(user.attachments?.length ? { attachments: user.attachments } : {}) } } : {}) } });
        }
        else if (user) {
          drafts.push({ id: `user:v1:${user.turnId}:r1`, at: Date.now(), kind: 'user', turnId: user.turnId, revision: 1, payload: { text: user.text, ...(user.attachments?.length ? { attachments: user.attachments } : {}) } });
        }
        return runCommand(database, method, [...args.slice(0, 4), drafts]);
      });
    }
    return runCommand(database, method, args);
  }
  if (method.startsWith('chats.')) {
    const name = method.slice(6);
    if (typeof args[0] === 'string' && database.record(args[0]))
      await importTranscript(args[0]);
    if (name === 'claimPendingMessage') {
      const id = args[0];
      await importTranscript(id);
      try {
        return database.transaction(() => {
          if (database.db.prepare("SELECT run_id FROM runs WHERE conversation_id=? AND status IN ('prepared','running')").get(id))
            return { ok: false, error: 'already-dispatching' };
          const pending = chats.getPendingDispatch(id);
          if (pending) {
            chats.completePendingDispatch(id, pending.messageId);
          }
          const result = chats.claimPendingMessage(id);
          if (result.ok && result.claimed && result.userMessage) {
            reconcilePending(id);
            const request = database.db.prepare('SELECT run_id,status FROM conversation_requests WHERE conversation_id=? AND request_id=?').get(id, result.userMessage.id);
            if (!request?.run_id && request?.status === 'admitted' && result.userMessage) {
              const runId = `run-${randomUUID()}`, at = Date.now();
              const record = { schemaVersion: 2, conversationId: id, runId, status: 'prepared', createdAt: at, updatedAt: at };
              database.db.prepare("INSERT INTO runs(run_id,conversation_id,status,record_json,request_id) VALUES(?,?,'prepared',?,?)").run(runId, id, JSON.stringify(record), result.userMessage.id);
              database.db.prepare('UPDATE conversation_requests SET run_id=? WHERE conversation_id=? AND request_id=?').run(runId, id, result.userMessage.id);
            }
          }
          return result;
        });
      }
      catch (error) {
        if (isWriteFailure(error))
          return { ok: false, error: 'write-failed' };
        if (!(error instanceof ConversationStoreError) || !['TRANSCRIPT_ENTRY_CONFLICT', 'REQUEST_IDEMPOTENCY_CONFLICT'].includes(error.code))
          throw error;
        return database.transaction(() => {
          const head = chats.getPendingMessages(id)?.[0];
          if (head) {
            const record = database.record(id)!;
            record.pendingMessages = record.pendingMessages?.slice(1);
            database.saveRecord(record);
            database.db.prepare("INSERT INTO conversation_requests(conversation_id,request_id,payload_json,status,error_code) VALUES(?,?,?,'rejected',?) ON CONFLICT(conversation_id,request_id) DO NOTHING").run(id, head.id, JSON.stringify(head), error.code);
          }
          return { ok: false, error: 'request-conflict' };
        });
      }
    }
    if (name === 'reconcilePendingDispatch') {
      await importTranscript(args[0]);
      return database.transaction(() => { reconcilePending(args[0]); return true; });
    }
    if (name === 'commitPendingAdjust') {
      try {
        return database.transaction(() => {
          const pending = chats.getPendingMessages(args[0])?.find(item => item.id === args[1]);
          const result = chats.commitPendingAdjust(args[0], args[1], args[2]);
          if (result.ok && pending) {
            database.append(args[0], { id: `user:v1:${pending.id}:r1`, at: result.userMessage.at, kind: 'user', turnId: pending.id, revision: 1,
              payload: { text: pending.rawContent, ...(pending.attachments?.length ? { attachments: pending.attachments } : {}) } });
          if (pending.userSticker) {
            try { presentation(args[0], `user:v1:${pending.id}:r1`, `adjust:${pending.id}`, { sticker: pending.userSticker }, result.userMessage.at); }
            catch (error) { console.warn('[conversation-store] 插话展示更新失败:', error); }
          }
            const record = database.record(args[0])!;
            if (record.schemaVersion === 2)
              record.messageCount = reduceTranscriptProjection(database.entries(args[0], true)).messages.length;
            record.updatedAt = result.userMessage.at;
            database.saveRecord(record);
          }
          if (!result.ok && result.error === 'write-failed')
            throw new ConversationStoreError('CONVERSATION_STORE_WRITE_FAILED');
          return result;
        });
      }
      catch (error) {
        if (isWriteFailure(error))
          return { ok: false, error: 'write-failed' };
        throw error;
      }
    }
    const fn = chats[name as keyof typeof chats];
    if (typeof fn !== 'function')
      throw new Error('CONVERSATION_DATABASE_UNKNOWN_COMMAND');
    if (/^(get|list)/.test(name))
      return (fn as (...args: any[]) => unknown)(...args);
    try {
      return database.transaction(() => {
        const result = (fn as (...args: any[]) => unknown)(...args) as any;
        if (result?.ok === false && result.error === 'write-failed')
          throw new ConversationStoreError('CONVERSATION_STORE_WRITE_FAILED');
        return result;
      });
    }
    catch (error) {
      if (isWriteFailure(error) && /^(enqueuePending|removePending|editPending|markPending|beginPending|commitPending|completePending)/.test(name))
        return { ok: false, error: 'write-failed', ...(name === 'editPendingMessage' ? { queue: chats.getPendingMessages(args[0]) ?? [] } : {}) };
      throw error;
    }
  }
  if (method.startsWith('transcript.')) {
    const name = method.slice(11), id = args[0];
    await importTranscript(id);
    if (name === 'read')
      return database.snapshot(id);
    if (name === 'audit')
      return database.entries(id, true);
    if (name === 'append')
      return database.append(id, args[1]);
    if (name === 'presentation')
      return presentation(id, args[1], args[2], args[3], args[4]);
    if (name === 'compaction')
      return database.transaction(() => {
        const input = args[1] as Extract<TranscriptAppendInput, {
          kind: 'compaction_checkpoint';
        }>;
        const entries = database.entries(id);
        const p = input.payload;
        const prefix = entries.filter(e => e.seq <= p.sourceThroughSeq);
        if (createHash('sha256').update(JSON.stringify(prefix)).digest('hex') !== p.sourceDigest || entries.some(e => e.seq > p.baseThroughSeq && ['compaction_checkpoint', 'turn_rewind', 'turn_tombstone'].includes(e.kind)))
          throw new ConversationStoreError('TRANSCRIPT_COMPACTION_REQUIRED');
        return database.append(id, input);
      });
    if (name === 'archive')
      return database.transaction(() => {
        const boundary = args[1];
        if (!Number.isInteger(boundary) || boundary < 1)
          throw new Error('TRANSCRIPT_ARCHIVE_INVALID_BOUNDARY');
        const row = database.db.prepare('SELECT archived_through FROM conversations WHERE id=?').get(id)!;
        if (boundary <= Number(row.archived_through))
          return;
        if (!database.entries(id).some(e => e.kind === 'compaction_checkpoint' && e.seq > boundary && e.payload.sourceThroughSeq >= boundary))
          throw new Error('TRANSCRIPT_ARCHIVE_BOUNDARY_NOT_COMMITTED');
        database.db.prepare('UPDATE conversations SET archived_through=? WHERE id=?').run(boundary, id);
      });
    if (name === 'delete') {
      database.transaction(() => { database.db.prepare('DELETE FROM transcript_entries WHERE conversation_id=?').run(id); database.db.prepare("UPDATE conversations SET max_seq=0,archived_through=0,projection_json=NULL,transcript_imported=1 WHERE id=?").run(id); });
      return;
    }
  }
  if (method.startsWith('tasks.')) {
    return database.transaction(() => runTaskCommand(database, method, args));
  }
  if (method.startsWith('usage.')) {
    return runUsageCommand(database, method, args);
  }
  if (method.startsWith('tools.')) {
    const [scope, id, fingerprint] = args;
    if (method === 'tools.begin')
      return database.transaction(() => {
        const row = database.db.prepare('SELECT * FROM tool_operations WHERE scope_id=? AND operation_id=?').get(scope, id);
        if (row) {
          if (row.fingerprint !== fingerprint)
            throw new ConversationStoreError('E_LOGICAL_INVOCATION_CONFLICT');
          if (row.status === 'succeeded' || row.status === 'ready')
            return { outcome: JSON.parse(row.outcome_json as string) };
          if (row.status === 'unknown' || row.status === 'started')
            throw new ConversationStoreError('EXECUTION_OUTCOME_UNKNOWN');
        }
        database.db.prepare(`INSERT INTO tool_operations(scope_id,operation_id,fingerprint,status) VALUES(?,?,?,'started')
    ON CONFLICT(scope_id,operation_id) DO UPDATE SET status='started'`).run(scope, id, fingerprint);
        return null;
      });
    if (method === 'tools.finish')
      return database.transaction(() => {
        const row = database.db.prepare('SELECT fingerprint,status,outcome_json FROM tool_operations WHERE scope_id=? AND operation_id=?').get(scope, id);
        if (!row || row.fingerprint !== fingerprint)
          throw new ConversationStoreError('E_LOGICAL_INVOCATION_CONFLICT');
        const outcome = args[3];
        if (['ready', 'succeeded', 'retryable'].includes(row.status as string) && row.outcome_json && isDeepStrictEqual(JSON.parse(row.outcome_json as string), persisted(outcome)))
          return;
        if (row.status !== 'started')
          throw new ConversationStoreError('EXECUTION_OUTCOME_UNKNOWN');
        database.db.prepare('UPDATE tool_operations SET status=?,outcome_json=? WHERE scope_id=? AND operation_id=?')
          .run(outcome?.status === 'succeeded' && outcome?.terminal !== false ? (args[4] ? 'ready' : 'succeeded') : outcome?.effectState === 'unknown' ? 'unknown' : 'retryable', outcome ? JSON.stringify(outcome) : null, scope, id);
      });
  }
  throw new Error('CONVERSATION_DATABASE_UNKNOWN_COMMAND');
}
function isWriteFailure(error: unknown): boolean {
  const code = (error as {
    code?: string;
  })?.code;
  return code === 'CONVERSATION_STORE_WRITE_FAILED' || code?.startsWith('ERR_SQLITE') === true;
}
let tail = Promise.resolve();
parentPort!.on('message', message => {
  tail = tail.then(async () => {
    try {
      const result = await execute(message.method, message.args);
      parentPort!.postMessage({ id: message.id, result });
    }
    catch (error) {
      const failure = error as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      parentPort!.postMessage({ id: message.id, error: { code: failure.code ?? failure.message, details: { method: message.method, ...failure.details } }, retired: database.isRetired });
    }
  });
});
