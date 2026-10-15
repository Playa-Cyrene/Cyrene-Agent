import type { ConversationDatabase } from "./conversation-database";
import { reduceTranscriptProjection } from "../orchestrator/conversation-transcript-projection";
import type { MemoryPendingStore, PendingMemoryBatch, PendingMemoryTurn } from "../memory/memory-pending-types";

/** Immutable transcript entry IDs are the source version; presentation patches are not evidence. */
function activeSources(database: ConversationDatabase, id: string): Map<string, { userEntryId: string; assistantEntryId: string }> {
  const sources = new Map<string, { userEntryId: string; assistantEntryId: string }>();
  if (database.db.prepare('SELECT deleted FROM conversations WHERE id=?').get(id)?.deleted) return sources;
  const entries = database.entries(id, true);
  const nodes = reduceTranscriptProjection(entries).state?.nodes ?? [];
  const entryRuns = new Map(entries.map(entry => [entry.id, entry.runId]));
  const users = new Map(nodes.filter(node => node.kind === 'user' && node.turnId).map(node => [node.turnId!, node]));
  const runUsers = new Map<string, string>();
  for (const row of database.db.prepare('SELECT run_id,dispatch_json,payload_json FROM conversation_requests WHERE conversation_id=? AND run_id IS NOT NULL').all(id)) {
    const facts = JSON.parse((row.dispatch_json ?? row.payload_json) as string);
    const turnId = facts.currentUser?.turnId ?? facts.turnId;
    if (turnId) runUsers.set(row.run_id as string, turnId);
  }
  let user: (typeof nodes)[number] | undefined;
  for (const node of nodes) {
    if (node.kind === 'user') user = node;
    else if (node.kind === 'assistant') {
      // 插话也是 user 条目，但回复仍属于发起该 run 的用户；旧轨迹没有请求回执时沿用相邻关系。
      const origin = runUsers.get(entryRuns.get(node.entryId) ?? '');
      const source = origin ? users.get(origin) : user;
      if (source?.turnId) sources.set(source.turnId, { userEntryId: source.entryId, assistantEntryId: node.entryId });
    }
  }
  return sources;
}

/** Called in the same transaction as rewind/tombstone so counted, cached sources agree. */
export function reconcileMemoryTurns(database: ConversationDatabase, id: string): void {
  const rows = database.db.prepare('SELECT user_turn_id,user_entry_id,assistant_entry_id FROM memory_pending_turns WHERE conversation_id=? AND active=1').all(id);
  if (!rows.length) return;
  const sources = activeSources(database, id);
  const invalidate = database.db.prepare('UPDATE memory_pending_turns SET active=0,payload_json=NULL WHERE conversation_id=? AND user_turn_id=?');
  for (const row of rows) {
    const source = sources.get(row.user_turn_id as string);
    if (!source || source.userEntryId !== row.user_entry_id || source.assistantEntryId !== row.assistant_entry_id) {
      invalidate.run(id, row.user_turn_id!);
    }
  }
}

function roundCount(database: ConversationDatabase): number {
  return Number(database.db.prepare('SELECT legacy_count FROM memory_scheduler_state WHERE id=1').get()?.legacy_count ?? 0)
    + Number(database.db.prepare('SELECT COUNT(*) AS n FROM memory_pending_turns WHERE active=1').get()!.n);
}

function current(database: ConversationDatabase, turns: PendingMemoryTurn[]): boolean {
  for (const id of new Set(turns.map(turn => turn.conversationId))) reconcileMemoryTurns(database, id);
  return turns.every(turn => {
    const row = database.db.prepare('SELECT * FROM memory_pending_turns WHERE conversation_id=? AND user_turn_id=? AND active=1')
      .get(turn.conversationId, turn.userTurnId);
    return row?.seq === turn.seq && row.user_entry_id === turn.userEntryId && row.assistant_entry_id === turn.assistantEntryId;
  });
}

export function runMemoryCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  if (method === 'memory.record') {
    const [turn, legacyCount] = args as [Parameters<MemoryPendingStore['record']>[0], number];
    database.db.prepare('INSERT OR IGNORE INTO memory_scheduler_state(id,legacy_count) VALUES(1,?)').run(Math.max(0, legacyCount));
    reconcileMemoryTurns(database, turn.conversationId);
    const source = activeSources(database, turn.conversationId).get(turn.userTurnId);
    // A delayed completion after a rewind/delete must not resurrect its old reply.
    if (!source || source.assistantEntryId !== turn.assistantEntryId) return { roundCount: roundCount(database), added: false };
    const old = database.db.prepare('SELECT * FROM memory_pending_turns WHERE conversation_id=? AND user_turn_id=?').get(turn.conversationId, turn.userTurnId);
    if (old?.active && old.user_entry_id === source.userEntryId && old.assistant_entry_id === source.assistantEntryId) {
      return { roundCount: roundCount(database), added: false, seq: Number(old.seq) };
    }
    database.db.prepare(`INSERT INTO memory_pending_turns(conversation_id,user_turn_id,user_entry_id,assistant_entry_id,payload_json,active,processed)
      VALUES(?,?,?,?,?,1,0) ON CONFLICT(conversation_id,user_turn_id) DO UPDATE SET
      user_entry_id=excluded.user_entry_id,assistant_entry_id=excluded.assistant_entry_id,payload_json=excluded.payload_json,active=1,processed=0`)
      .run(turn.conversationId, turn.userTurnId, source.userEntryId, turn.assistantEntryId, JSON.stringify({ userInput: turn.userInput, assistantReply: turn.assistantReply }));
    const row = database.db.prepare('SELECT seq FROM memory_pending_turns WHERE conversation_id=? AND user_turn_id=?').get(turn.conversationId, turn.userTurnId)!;
    return { roundCount: roundCount(database), added: !old, seq: Number(row.seq) };
  }
  if (method === 'memory.batch') {
    const id = args[0] as string;
    reconcileMemoryTurns(database, id);
    const rows = database.db.prepare('SELECT * FROM memory_pending_turns WHERE conversation_id=? AND active=1 AND processed=0 AND seq<=? ORDER BY seq LIMIT 6').all(id, args[1] ?? Number.MAX_SAFE_INTEGER);
    if (rows.length < 6) return null;
    const prior = database.db.prepare('SELECT * FROM memory_pending_turns WHERE conversation_id=? AND active=1 AND processed=1 AND payload_json IS NOT NULL AND seq<? ORDER BY seq DESC LIMIT 2').all(id, rows[0].seq!);
    const decode = (row: (typeof rows)[number]): PendingMemoryTurn => ({
      ...JSON.parse(row.payload_json as string), seq: Number(row.seq), conversationId: id,
      userTurnId: row.user_turn_id as string, userEntryId: row.user_entry_id as string, assistantEntryId: row.assistant_entry_id as string,
    });
    return { turns: [...prior.reverse(), ...rows].map(decode), pending: rows.map(decode) } satisfies PendingMemoryBatch;
  }
  if (method === 'memory.current') return current(database, args[0]);
  if (method === 'memory.consume') {
    const batch = args[0] as PendingMemoryBatch;
    if (!current(database, batch.turns)) return false;
    for (const turn of batch.pending) database.db.prepare('UPDATE memory_pending_turns SET processed=1 WHERE seq=?').run(turn.seq);
    const id = batch.pending[0].conversationId;
    // Keep two processed turns for overlap. The small identity ledger remains for round counting.
    database.db.prepare(`UPDATE memory_pending_turns SET payload_json=NULL WHERE conversation_id=? AND processed=1
      AND seq NOT IN (SELECT seq FROM memory_pending_turns WHERE conversation_id=? AND active=1 AND processed=1 ORDER BY seq DESC LIMIT 2)`).run(id, id);
    return true;
  }
  if (method === 'memory.count') return roundCount(database);
  throw new Error('CONVERSATION_DATABASE_UNKNOWN_COMMAND');
}
