import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertValidTranscriptDraft, userRevisionKey, type TranscriptAppendInput, type TranscriptEntry, type TranscriptSnapshotV2 } from "../orchestrator/conversation-transcript-types";
import { validateLoadedTranscriptEntry } from "../orchestrator/conversation-transcript-validation";
import type { ChatSessionRecord } from "../../shared/chat-types";
import { ConversationStoreError } from "./conversation-store-error";
export { ConversationStoreError } from "./conversation-store-error";
/** JSON is the persistence boundary: transient undefined properties do not affect retries. */
export function persisted<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function semantic(entry: TranscriptAppendInput | TranscriptEntry): unknown {
  const { id: _id, at: _at, ...fields } = entry as TranscriptEntry;
  const { seq: _seq, ...facts } = fields;
  if (facts.kind === "user")
    delete facts.runId;
  return persisted(facts);
}
/** Only the database worker may instantiate this class. All transaction callbacks are synchronous. */
export class ConversationDatabase {
  readonly db: DatabaseSync;
  private depth = 0;
  private retired = false;
  constructor(readonly userDataRoot: string) {
    fs.mkdirSync(userDataRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(userDataRoot, "cyrene.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, record_json TEXT, max_seq INTEGER NOT NULL DEFAULT 0,
    archived_through INTEGER NOT NULL DEFAULT 0, projection_json TEXT, transcript_imported INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS conversation_requests(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, error_code TEXT,
    PRIMARY KEY(conversation_id,request_id));
   CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL, record_json TEXT NOT NULL, request_id TEXT);
   CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,status);
   CREATE TABLE IF NOT EXISTS transcript_entries(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, turn_id TEXT, revision INTEGER,
    message_id TEXT, mutation_key TEXT, patch_revision INTEGER, entry_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id,entry_id), UNIQUE(conversation_id,seq));
   CREATE UNIQUE INDEX IF NOT EXISTS transcript_user_revision ON transcript_entries(conversation_id,turn_id,revision) WHERE kind='user';
   CREATE UNIQUE INDEX IF NOT EXISTS transcript_presentation_key ON transcript_entries(conversation_id,message_id,mutation_key)
    WHERE kind='presentation_patch' AND mutation_key IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS transcript_presentation_revision ON transcript_entries(conversation_id,message_id,patch_revision)
    WHERE kind='presentation_patch';
   CREATE TABLE IF NOT EXISTS tool_operations(scope_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, outcome_json TEXT, PRIMARY KEY(scope_id,operation_id));
   INSERT OR IGNORE INTO schema_migrations VALUES(1);`);
    if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE conversation_requests ADD COLUMN dispatch_json TEXT; INSERT INTO schema_migrations VALUES(2)");
      });
    }
    if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()) {
      this.transaction(() => this.db.exec("ALTER TABLE tool_operations ADD COLUMN receipt_entry_id TEXT; INSERT INTO schema_migrations VALUES(3)"));
    }
    if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()) {
      this.transaction(() => this.db.exec("ALTER TABLE conversations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0; INSERT INTO schema_migrations VALUES(4)"));
    }
    this.transaction(() => {
      const rows = this.db.prepare("SELECT run_id,record_json FROM runs WHERE status IN ('prepared','running')").all();
      for (const row of rows) {
        const record = JSON.parse(row.record_json as string);
        record.status = "interrupted";
        record.updatedAt = Date.now();
        this.db.prepare("UPDATE runs SET status='interrupted',record_json=? WHERE run_id=?").run(JSON.stringify(record), row.run_id!);
        this.db.prepare("UPDATE conversation_requests SET status='interrupted',error_code='EXECUTION_INTERRUPTED' WHERE run_id=?").run(row.run_id!);
      }
      this.db.exec("UPDATE tool_operations SET status='unknown' WHERE status IN ('started','ready')");
    });
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_active_conversation_run ON runs(conversation_id) WHERE status IN ('prepared','running')");
  }
  transaction<T>(action: () => T): T {
    if (this.retired)
      throw new ConversationStoreError("CONVERSATION_DATABASE_CONNECTION_RETIRED");
    if (this.depth)
      return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    }
    catch (error) {
      try {
        this.db.exec("ROLLBACK");
      }
      catch {
        this.retired = true;
        try {
          this.db.close();
        }
        catch { /* The connection must never serve another command. */ }
      }
      throw error;
    }
    finally {
      this.depth--;
    }
  }
  ensure(id: string): void {
    if (!id || id.includes("\0"))
      throw new ConversationStoreError("TRANSCRIPT_INVALID_CONVERSATION_ID");
    if (this.db.prepare('SELECT deleted FROM conversations WHERE id=?').get(id)?.deleted)
      throw new ConversationStoreError('CONVERSATION_DELETED');
    this.db.prepare("INSERT OR IGNORE INTO conversations(id) VALUES(?)").run(id);
  }
  record(id: string): ChatSessionRecord | null {
    const row = this.db.prepare("SELECT record_json FROM conversations WHERE id=?").get(id);
    return row?.record_json ? JSON.parse(row.record_json as string) : null;
  }
  records(): ChatSessionRecord[] {
    return this.db.prepare("SELECT record_json FROM conversations WHERE record_json IS NOT NULL").all().map(r => JSON.parse(r.record_json as string));
  }
  saveRecord(record: ChatSessionRecord): void {
    this.ensure(record.id);
    this.db.prepare("UPDATE conversations SET record_json=? WHERE id=?").run(JSON.stringify(record), record.id);
  }
  entries(id: string, audit = false): TranscriptEntry[] {
    return this.db.prepare(`SELECT entry_json,entry_id,seq,kind FROM transcript_entries WHERE conversation_id=?
   ${audit ? "" : "AND seq>(SELECT archived_through FROM conversations WHERE id=?)"} ORDER BY seq`).all(...(audit ? [id] : [id, id]))
      .map(row => {
      try {
        const entry = JSON.parse(row.entry_json as string) as TranscriptEntry;
        assertValidTranscriptDraft(entry);
        validateLoadedTranscriptEntry(entry);
        if (entry.id !== row.entry_id || entry.kind !== row.kind || entry.seq !== row.seq)
          throw new Error('INVALID_ENVELOPE');
        return entry;
      }
      catch {
        throw new ConversationStoreError('CONVERSATION_STORE_INTEGRITY_ERROR', { seq: row.seq });
      }
    });
  }
  private conflict(code: string, input: TranscriptAppendInput, existing: TranscriptEntry): never {
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
    throw new ConversationStoreError(code, { kind: input.kind, entryIdHash: hash(input.id), existingSeq: existing.seq,
      inputHash: hash(semantic(input)), existingHash: hash(semantic(existing)) });
  }
  append(id: string, draft: TranscriptAppendInput): TranscriptEntry {
    assertValidTranscriptDraft(draft);
    validateLoadedTranscriptEntry({ ...draft, seq: 1 });
    const input = persisted(draft);
    return this.transaction(() => {
      this.ensure(id);
      const byId = this.db.prepare("SELECT entry_json FROM transcript_entries WHERE conversation_id=? AND entry_id=?").get(id, input.id);
      let existing: TranscriptEntry | undefined = byId ? JSON.parse(byId.entry_json as string) : undefined;
      if (!existing && input.kind === "user") {
        const row = this.db.prepare("SELECT entry_json FROM transcript_entries WHERE conversation_id=? AND kind='user' AND turn_id=? AND revision=?").get(id, input.turnId!, input.revision!);
        existing = row ? JSON.parse(row.entry_json as string) : undefined;
      }
      if (existing) {
        if (isDeepStrictEqual(semantic(input), semantic(existing)))
          return existing;
        this.conflict(input.kind === "presentation_patch" ? "PRESENTATION_MUTATION_CONFLICT" : "TRANSCRIPT_ENTRY_CONFLICT", input, existing);
      }
      const row = this.db.prepare("SELECT max_seq FROM conversations WHERE id=?").get(id)!;
      const entry = { ...input, seq: Number(row.max_seq) + 1, at: input.at ?? Date.now() } as TranscriptEntry;
      this.insert(id, entry);
      if (entry.kind === "tool_result" && entry.runId) {
        const operationId = `${entry.runId}:${entry.payload.toolCallId}`;
        this.db.prepare("UPDATE tool_operations SET status=CASE WHEN ?='success' AND status='ready' THEN 'succeeded' WHEN ?='unknown' THEN 'unknown' ELSE status END,receipt_entry_id=? WHERE scope_id=? AND operation_id=?")
          .run(entry.payload.outcome, entry.payload.outcome, entry.id, id, operationId);
      }
      return entry;
    });
  }
  insert(id: string, entry: TranscriptEntry): void {
    assertValidTranscriptDraft(entry);
    const p = entry.kind === "presentation_patch" ? entry.payload : undefined;
    this.db.prepare(`INSERT INTO transcript_entries(conversation_id,entry_id,seq,kind,turn_id,revision,message_id,mutation_key,patch_revision,entry_json)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, entry.id, entry.seq, entry.kind, entry.turnId ?? null, entry.revision ?? null, p?.messageId ?? null, p?.mutationKey ?? null, p?.patchRevision ?? null, JSON.stringify(entry));
    this.db.prepare("UPDATE conversations SET max_seq=MAX(max_seq,?) WHERE id=?").run(entry.seq, id);
  }
  snapshot(id: string): TranscriptSnapshotV2 {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    const audit = this.entries(id, true);
    if (audit.length !== Number(row?.max_seq ?? 0) || audit.some((entry, index) => entry.seq !== index + 1))
      throw new ConversationStoreError('CONVERSATION_STORE_INTEGRITY_ERROR');
    let projection = { throughSeq: 0, messages: [] } as TranscriptSnapshotV2['projection'];
    try {
      if (row?.projection_json)
        projection = JSON.parse(row.projection_json as string);
    }
    catch { /* Rebuildable state never hides canonical rows. */ }
    return { schemaVersion: 2, throughSeq: Number(row?.max_seq ?? 0), entries: this.entries(id), archives: [],
      projection,
      seenEntryIds: audit.map(e => e.id), seenUserRevisions: audit.filter(e => e.kind === 'user').map(e => userRevisionKey(e.turnId!, e.revision!)) };
  }
  close(): void { this.db.close(); }
  get isRetired(): boolean { return this.retired; }
}
let database: ConversationDatabase;
export function initializeConversationDatabase(root: string): ConversationDatabase { return database = new ConversationDatabase(root); }
export function getWorkerDatabase(): ConversationDatabase {
  if (!database)
    throw new Error("CONVERSATION_DATABASE_NOT_INITIALIZED");
  return database;
}
