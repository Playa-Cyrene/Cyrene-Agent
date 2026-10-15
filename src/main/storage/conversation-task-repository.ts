/**
 * 任务会话仓储（worker 侧）：task_sessions / task_trace 的全部 SQL。
 *
 * 业务语义与退役的 JSON 实现一一对应：
 * - resume/close 的守卫错误码保持原样（TASK_PARENT_MISMATCH 等），
 *   ConversationStoreError 的 message 即 code，调用方的错误提示不变；
 * - checkpoint 的 trace 为全量替换（调用方维护完整内存数组），上限 2000 条；
 * - resume 清空 resultText/error/completedAt，列置 NULL，读侧映射为字段缺失。
 *
 * 旧 JSON 文件（cyrene-tasks/sessions/*.json）启动时一次性只读导入，
 * 源文件保留；损坏文件告警跳过，不阻断其他会话（与 importRuns 同策略）。
 */

import fs from "node:fs";
import path from "node:path";
import { ConversationDatabase } from "./conversation-database";
import { ConversationStoreError } from "./conversation-store-error";
import type { TaskSession, TaskSessionStatus, TaskSubagentType, TodoItem } from "../../shared/task-session";

const TRACE_LIMIT = 2_000;

function isTaskStatus(value: unknown): value is TaskSessionStatus {
  return value === "running" || value === "completed" || value === "failed"
    || value === "cancelled" || value === "interrupted";
}

function isTaskType(value: unknown): value is TaskSubagentType {
  return value === "general" || value === "document" || value === "search";
}

function isTodoStatus(value: unknown): value is TodoItem["status"] {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function cloneTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<TodoItem>;
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0
      || typeof candidate.content !== "string" || candidate.content.trim().length === 0
      || !isTodoStatus(candidate.status)) return [];
    return [{
      id: candidate.id,
      content: candidate.content,
      status: candidate.status,
      ...(typeof candidate.activeForm === "string" ? { activeForm: candidate.activeForm } : {}),
    }];
  });
}

function isTaskSession(value: unknown): value is TaskSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<TaskSession>;
  return session.schemaVersion === 1
    && typeof session.id === "string"
    && typeof session.parentConversationId === "string"
    && typeof session.parentRunId === "string"
    && typeof session.childRunId === "string"
    && typeof session.description === "string"
    && isTaskType(session.subagentType)
    && (session.companionId === undefined || typeof session.companionId === "string")
    && (session.contextOpen === undefined || typeof session.contextOpen === "boolean")
    && (session.mode === "work" || session.mode === "code")
    && isTaskStatus(session.status)
    && Array.isArray(session.messages)
    && Array.isArray(session.trace)
    && typeof session.createdAt === "number"
    && typeof session.updatedAt === "number";
}

interface TaskSessionRow {
  id: string;
  parent_conversation_id: string;
  parent_run_id: string;
  child_run_id: string;
  description: string;
  subagent_type: string;
  companion_id: string | null;
  context_open: number;
  mode: string;
  resolved_workspace_root: string | null;
  status: string;
  messages_json: string;
  todo_items_json: string;
  result_text: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function rowToSession(database: ConversationDatabase, row: TaskSessionRow): TaskSession {
  const traceRows = database.db.prepare("SELECT record_json FROM task_trace WHERE task_id=? ORDER BY seq")
    .all(row.id) as Array<{ record_json: string }>;
  return {
    schemaVersion: 1,
    id: row.id,
    parentConversationId: row.parent_conversation_id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    description: row.description,
    subagentType: row.subagent_type as TaskSession["subagentType"],
    ...(row.companion_id ? { companionId: row.companion_id } : {}),
    contextOpen: row.context_open === 1,
    mode: row.mode as TaskSession["mode"],
    ...(row.resolved_workspace_root ? { resolvedWorkspaceRoot: row.resolved_workspace_root } : {}),
    status: row.status as TaskSession["status"],
    messages: JSON.parse(row.messages_json) as TaskSession["messages"],
    trace: traceRows.map((trace) => JSON.parse(trace.record_json) as TaskSession["trace"][number]),
    todoItems: JSON.parse(row.todo_items_json) as TodoItem[],
    ...(row.result_text !== null ? { resultText: row.result_text } : {}),
    ...(row.error_code !== null ? { error: { code: row.error_code, message: row.error_message ?? "" } } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function requireSessionRow(database: ConversationDatabase, taskId: string): TaskSessionRow {
  const row = database.db.prepare("SELECT * FROM task_sessions WHERE id=?").get(taskId) as TaskSessionRow | undefined;
  if (!row) throw new ConversationStoreError("TASK_NOT_FOUND");
  return row;
}

function writeTraceRows(database: ConversationDatabase, taskId: string, trace: TaskSession["trace"]): void {
  database.db.prepare("DELETE FROM task_trace WHERE task_id=?").run(taskId);
  const insert = database.db.prepare("INSERT INTO task_trace(task_id,seq,record_json) VALUES(?,?,?)");
  for (const [index, record] of trace.entries()) {
    insert.run(taskId, index, JSON.stringify(record));
  }
}

export function importTaskSessions(database: ConversationDatabase): void {
  if (database.db.prepare("SELECT version FROM schema_migrations WHERE version=102").get()) return;
  const directory = path.join(database.userDataRoot, "cyrene-tasks", "sessions");
  let allValid = true;
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        if (!isTaskSession(parsed)) {
          throw new ConversationStoreError("CONVERSATION_STORE_INTEGRITY_ERROR", { source: "legacy_task" });
        }
        const session = parsed.status === "running" ? { ...parsed, status: "interrupted" as const } : parsed;
        database.transaction(() => {
          database.db.prepare(`INSERT INTO task_sessions(id,parent_conversation_id,parent_run_id,child_run_id,description,subagent_type,
   companion_id,context_open,mode,resolved_workspace_root,status,messages_json,todo_items_json,result_text,error_code,error_message,created_at,updated_at,completed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(id) DO NOTHING`).run(
            session.id, session.parentConversationId, session.parentRunId, session.childRunId, session.description,
            session.subagentType, session.companionId ?? null, session.contextOpen === false ? 0 : 1, session.mode,
            session.resolvedWorkspaceRoot ?? null, session.status, JSON.stringify(session.messages),
            JSON.stringify(session.todoItems), session.resultText ?? null, session.error?.code ?? null,
            session.error?.message ?? null, session.createdAt, session.updatedAt, session.completedAt ?? null,
          );
          writeTraceRows(database, session.id, session.trace);
        });
      } catch (error) {
        allValid = false;
        console.warn("[conversation-store] 保留无法导入的旧任务文件:", name, error);
      }
    }
  }
  if (allValid) database.db.prepare("INSERT INTO schema_migrations VALUES(102)").run();
}

export function runTaskCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  const db = database.db;
  if (method === "tasks.insert") {
    const session = args[0] as TaskSession;
    if (!isTaskSession(session)) throw new ConversationStoreError("CONVERSATION_STORE_INTEGRITY_ERROR", { source: "task_insert" });
    return database.transaction(() => {
      database.db.prepare(`INSERT INTO task_sessions(id,parent_conversation_id,parent_run_id,child_run_id,description,subagent_type,
   companion_id,context_open,mode,resolved_workspace_root,status,messages_json,todo_items_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        session.id, session.parentConversationId, session.parentRunId, session.childRunId, session.description,
        session.subagentType, session.companionId ?? null, session.contextOpen === false ? 0 : 1, session.mode,
        session.resolvedWorkspaceRoot ?? null, session.status, JSON.stringify(session.messages),
        JSON.stringify(session.todoItems), session.createdAt, session.updatedAt,
      );
      return session;
    });
  }
  if (method === "tasks.get") {
    const row = db.prepare("SELECT * FROM task_sessions WHERE id=?").get(args[0]) as TaskSessionRow | undefined;
    return row ? rowToSession(database, row) : null;
  }
  if (method === "tasks.findOpenByCompanion") {
    const [parentConversationId, companionId] = args;
    const row = db.prepare(`SELECT * FROM task_sessions WHERE parent_conversation_id=? AND companion_id=?
   AND context_open=1 ORDER BY updated_at DESC LIMIT 1`).get(parentConversationId, companionId) as TaskSessionRow | undefined;
    return row ? rowToSession(database, row) : null;
  }
  if (method === "tasks.listOpenCompanions") {
    const rows = db.prepare(`SELECT companion_id, MAX(updated_at) AS latest FROM task_sessions
   WHERE parent_conversation_id=? AND companion_id IS NOT NULL AND context_open=1
   GROUP BY companion_id ORDER BY latest DESC`).all(args[0]) as Array<{ companion_id: string }>;
    return rows.map((row) => row.companion_id);
  }
  if (method === "tasks.listForParent") {
    const rows = db.prepare("SELECT * FROM task_sessions WHERE parent_conversation_id=? ORDER BY updated_at DESC")
      .all(args[0]) as unknown as TaskSessionRow[];
    return rows.map((row) => rowToSession(database, row));
  }
  if (method === "tasks.closeByCompanion") {
    const [parentConversationId, companionId, now] = args;
    return database.transaction(() => {
      const row = db.prepare(`SELECT * FROM task_sessions WHERE parent_conversation_id=? AND companion_id=?
   AND context_open=1 ORDER BY updated_at DESC LIMIT 1`).get(parentConversationId, companionId) as TaskSessionRow | undefined;
      if (!row) throw new ConversationStoreError("TASK_COMPANION_CONTEXT_NOT_OPEN");
      if (row.status === "running") throw new ConversationStoreError("TASK_ALREADY_RUNNING");
      db.prepare("UPDATE task_sessions SET context_open=0, updated_at=? WHERE id=?").run(now, row.id);
      return rowToSession(database, requireSessionRow(database, row.id));
    });
  }
  if (method === "tasks.resume") {
    const [taskId, input, newChildRunId, now] = args;
    return database.transaction(() => {
      const row = requireSessionRow(database, taskId);
      if (row.parent_conversation_id !== input.parentConversationId) throw new ConversationStoreError("TASK_PARENT_MISMATCH");
      if (row.subagent_type !== input.subagentType) throw new ConversationStoreError("TASK_PROFILE_MISMATCH");
      if (row.context_open === 0) throw new ConversationStoreError("TASK_CONTEXT_CLOSED");
      if (input.companionId && row.companion_id && row.companion_id !== input.companionId) throw new ConversationStoreError("TASK_COMPANION_MISMATCH");
      if (row.status === "running") throw new ConversationStoreError("TASK_ALREADY_RUNNING");
      const messages = JSON.parse(row.messages_json) as TaskSession["messages"];
      messages.push({ role: "user", content: input.prompt });
      db.prepare(`UPDATE task_sessions SET companion_id=?, context_open=1, parent_run_id=?, child_run_id=?,
   status='running', messages_json=?, result_text=NULL, error_code=NULL, error_message=NULL, completed_at=NULL, updated_at=? WHERE id=?`)
        .run(input.companionId ?? row.companion_id, input.parentRunId, newChildRunId, JSON.stringify(messages), now, taskId);
      return rowToSession(database, requireSessionRow(database, taskId));
    });
  }
  if (method === "tasks.checkpoint") {
    const [taskId, patch, now] = args;
    return database.transaction(() => {
      requireSessionRow(database, taskId);
      if (patch.trace !== undefined) writeTraceRows(database, taskId, patch.trace.slice(-TRACE_LIMIT));
      const todoItems = patch.todoItems !== undefined ? JSON.stringify(cloneTodoItems(patch.todoItems)) : undefined;
      db.prepare(`UPDATE task_sessions SET
   parent_run_id=COALESCE(?, parent_run_id),
   child_run_id=COALESCE(?, child_run_id),
   status=COALESCE(?, status),
   todo_items_json=COALESCE(?, todo_items_json),
   result_text=CASE WHEN ? THEN ? ELSE result_text END,
   error_code=CASE WHEN ? THEN ? ELSE error_code END,
   error_message=CASE WHEN ? THEN ? ELSE error_message END,
   completed_at=CASE WHEN ? THEN ? ELSE completed_at END,
   updated_at=? WHERE id=?`).run(
        patch.parentRunId ?? null,
        patch.childRunId ?? null,
        patch.status ?? null,
        todoItems ?? null,
        patch.resultText !== undefined ? 1 : 0, patch.resultText ?? null,
        patch.error !== undefined ? 1 : 0, patch.error?.code ?? null,
        patch.error !== undefined ? 1 : 0, patch.error?.message ?? null,
        patch.completedAt !== undefined ? 1 : 0, patch.completedAt ?? null,
        now, taskId,
      );
      return rowToSession(database, requireSessionRow(database, taskId));
    });
  }
  throw new ConversationStoreError("CONVERSATION_DATABASE_UNKNOWN_COMMAND");
}
