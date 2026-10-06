import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ConversationDatabase, persisted } from "./conversation-database";
import { ConversationStoreError, diagnosticHash } from "./conversation-store-error";
import type { CreateHarnessRunInput, HarnessRunSession } from "../orchestrator/harness/run-store";
export function importRuns(database: ConversationDatabase): void {
  if (database.db.prepare("SELECT version FROM schema_migrations WHERE version=101").get())
    return;
  const directory = path.join(database.userDataRoot, "cyrene-runs", "sessions");
  let allValid = true;
  if (fs.existsSync(directory))
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json"))
        continue;
      try {
        let record: HarnessRunSession;
        try {
          record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        }
        catch {
          throw new ConversationStoreError("CONVERSATION_STORE_INTEGRITY_ERROR", { source: "legacy_run" });
        }
        if (![1, 2].includes(record.schemaVersion) || !record.conversationId || !record.runId || typeof record.createdAt !== "number"
          || !['running', 'interrupted', 'completed', 'cancelled', 'failed'].includes(record.status)) {
          throw new ConversationStoreError("CONVERSATION_STORE_INTEGRITY_ERROR", { source: "legacy_run" });
        }
        database.transaction(() => {
          if (database.db.prepare('SELECT deleted FROM conversations WHERE id=?').get(record.conversationId)?.deleted)
            return;
          database.ensure(record.conversationId);
          if (record.status === "running")
            record = { ...record, status: "interrupted", updatedAt: Date.now() };
          database.db.prepare("INSERT OR IGNORE INTO runs(run_id,conversation_id,status,record_json) VALUES(?,?,?,?)")
            .run(record.runId, record.conversationId, record.status, JSON.stringify(record));
        });
      }
      catch (error) {
        allValid = false;
        console.warn('[conversation-store] 保留无法导入的旧运行文件:', name, error);
      }
    }
  if (allValid)
    database.db.prepare("INSERT INTO schema_migrations VALUES(101)").run();
}
export interface DispatchReceipt {
  runId: string;
  status: string;
  duplicate: boolean;
  error?: string;
}
export function runCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  const db = database.db;
  if (method === 'runs.failRequest')
    return database.transaction(() => {
      const request = db.prepare('SELECT * FROM conversation_requests WHERE conversation_id=? AND request_id=?').get(args[0], args[1]);
      if (request?.run_id && !request.dispatch_json && request.status === 'admitted')
        return runCommand(database, 'runs.terminal', [request.run_id, 'failed', Date.now(), args[2]]);
    });
  if (method === "runs.all")
    return db.prepare("SELECT record_json FROM runs").all().map(row => JSON.parse(row.record_json as string));
  if (method === "runs.lookup" || method === "runs.admit") {
    const [conversationId, requestId, rawFacts, candidateRunId, drafts = []] = args;
    const facts = persisted(rawFacts);
    return database.transaction(() => {
      database.ensure(conversationId);
      const request = db.prepare("SELECT * FROM conversation_requests WHERE conversation_id=? AND request_id=?").get(conversationId, requestId);
      if (request?.status === 'rejected')
        throw new ConversationStoreError('REQUEST_IDEMPOTENCY_CONFLICT');
      if (request && !request.dispatch_json && facts.currentUser) {
        const saved = JSON.parse(request.payload_json as string);
        if (!isDeepStrictEqual(saved.currentUser ?? saved, facts.currentUser))
          throw new ConversationStoreError('REQUEST_IDEMPOTENCY_CONFLICT', { requestIdHash: diagnosticHash(requestId), inputHash: diagnosticHash(facts.currentUser), existingHash: diagnosticHash(saved.currentUser ?? saved) });
      }
      if (request?.dispatch_json && !isDeepStrictEqual(JSON.parse(request.dispatch_json as string), facts)) {
        throw new ConversationStoreError("REQUEST_IDEMPOTENCY_CONFLICT", { requestIdHash: diagnosticHash(requestId), inputHash: diagnosticHash(facts), existingHash: diagnosticHash(JSON.parse(request.dispatch_json as string)) });
      }
      if (request?.run_id && (request.dispatch_json || request.status !== 'admitted')) {
        return { runId: request.run_id, status: request.status, duplicate: true, ...(request.error_code ? { error: request.error_code } : {}) };
      }
      if (method === "runs.lookup")
        return null;
      const runId = request?.run_id as string | undefined ?? candidateRunId;
      const active = db.prepare("SELECT run_id FROM runs WHERE conversation_id=? AND status IN ('prepared','running')").get(conversationId);
      if (active && active.run_id !== runId)
        throw new ConversationStoreError("SESSION_RUN_ACTIVE", { runId: active.run_id });
      for (const draft of drafts)
        database.append(conversationId, draft);
      const now = Date.now();
      const record = { schemaVersion: 2, conversationId, runId, status: "prepared", createdAt: now, updatedAt: now };
      db.prepare("INSERT INTO runs(run_id,conversation_id,status,record_json,request_id) VALUES(?,?,'prepared',?,?) ON CONFLICT(run_id) DO UPDATE SET request_id=excluded.request_id")
        .run(runId, conversationId, JSON.stringify(record), requestId);
      db.prepare(`INSERT INTO conversation_requests(conversation_id,request_id,payload_json,dispatch_json,status,run_id)
    VALUES(?,?,?,?,'prepared',?) ON CONFLICT(conversation_id,request_id) DO UPDATE SET dispatch_json=excluded.dispatch_json,status='prepared',run_id=excluded.run_id,error_code=NULL`)
        .run(conversationId, requestId, JSON.stringify(facts), JSON.stringify(facts), runId);
      return { runId, status: "prepared", duplicate: false };
    });
  }
  if (method === "runs.create")
    return database.transaction(() => {
      const input = args[0] as CreateHarnessRunInput;
      if (!input.conversationId || !input.runId || input.runId.includes("\0"))
        throw new ConversationStoreError("HARNESS_RUN_INVALID_ID");
      database.ensure(input.conversationId);
      const existing = db.prepare("SELECT * FROM runs WHERE run_id=?").get(input.runId);
      if (existing && (existing.conversation_id !== input.conversationId || existing.status !== "prepared"))
        throw new ConversationStoreError("HARNESS_RUN_EXISTS");
      const now = args[1] ?? Date.now();
      const record = existing ? JSON.parse(existing.record_json as string) : { schemaVersion: 2, ...input, createdAt: now };
      record.status = "running";
      record.updatedAt = now;
      db.prepare(`INSERT INTO runs(run_id,conversation_id,status,record_json) VALUES(?,?,'running',?)
   ON CONFLICT(run_id) DO UPDATE SET status='running',record_json=excluded.record_json`).run(input.runId, input.conversationId, JSON.stringify(record));
      db.prepare("UPDATE conversation_requests SET status='running' WHERE run_id=?").run(input.runId);
      return record;
    });
  if (method === "runs.terminal")
    return database.transaction(() => {
      const [runId, status, at = Date.now(), error] = args;
      if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(status))
        throw new ConversationStoreError('HARNESS_RUN_INVALID_STATUS');
      const row = db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId);
      if (!row)
        throw new ConversationStoreError("HARNESS_RUN_NOT_FOUND");
      const record = JSON.parse(row.record_json as string);
      if (record.schemaVersion === 1)
        throw new ConversationStoreError('HARNESS_RUN_LEGACY_READ_ONLY');
      if (!["prepared", "running"].includes(row.status as string))
        return record;
      record.status = status;
      record.updatedAt = at;
      record.completedAt = at;
      db.prepare("UPDATE runs SET status=?,record_json=? WHERE run_id=?").run(status, JSON.stringify(record), runId);
      db.prepare("UPDATE conversation_requests SET status=?,error_code=? WHERE run_id=?").run(status, error ?? null, runId);
      return record;
    });
  if (method === "runs.delete") {
    db.prepare("DELETE FROM runs WHERE conversation_id=?").run(args[0]);
    return;
  }
  throw new ConversationStoreError("CONVERSATION_DATABASE_UNKNOWN_COMMAND");
}
